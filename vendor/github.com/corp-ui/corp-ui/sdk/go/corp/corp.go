// Package corp is the Go SDK for embedded services hosted inside corp-ui.
//
// Typical usage in a sub-service backend:
//
//	c := corp.New("https://console.example.com")
//	r.Use(c.Middleware) // any net/http middleware
//	r.Get("/api/foo", func(w http.ResponseWriter, r *http.Request) {
//	    u, _ := corp.UserFromContext(r.Context())
//	    if !u.Can("invoices", "w") {
//	        http.Error(w, "forbidden", http.StatusForbidden)
//	        return
//	    }
//	    fmt.Fprintln(w, "hello", u.Email, "account", u.AccountID)
//	})
//
// The middleware reads the bearer token from the Authorization header and
// validates it server-to-server against the console's introspection endpoint.
// A 30-second negative cache avoids hammering the console on every request.
package corp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// User is the validated identity of an iframe request.
type User struct {
	UserID         uint              `json:"user_id"`
	Email          string            `json:"email"`
	IsAdmin        bool              `json:"is_admin"`
	ServiceID      uint              `json:"service_id"`
	Slug           string            `json:"slug"`
	Perms          map[string]string `json:"perms"`
	AccountID      string            `json:"account_id"`
	Locale         string            `json:"locale"`
	Metadata       map[string]string `json:"metadata"`
	ImpersonatorID uint              `json:"impersonator_id"`
	ExpiresAt      int64             `json:"exp"`
	// CorpURL is the canonical URL of the corp-ui host that issued
	// the token. Useful for s2s callbacks back into corp-ui without
	// hard-coding the host on the module side.
	CorpURL string `json:"corp_url"`
}

// Can reports whether the user has at least the given access letter (r, w, a)
// on the named permission key. The special key "*" represents service-wide
// access and is checked as a fallback.
func (u *User) Can(key, level string) bool {
	if u == nil || level == "" {
		return false
	}
	if p, ok := u.Perms[key]; ok && strings.Contains(p, level) {
		return true
	}
	if p, ok := u.Perms["*"]; ok && strings.Contains(p, level) {
		return true
	}
	return false
}

// Client validates iframe tokens issued by the corp-ui console.
//
// To make server-to-server requests against /api/v1/* (e.g. look up a
// user by account_id), call Client.WithAPIKey to attach the per-service
// or global API key.
type Client struct {
	BaseURL    string
	HTTPClient *http.Client
	// CacheTTL controls how long a successful introspection result is cached.
	// Defaults to 30s. Set to 0 to disable.
	CacheTTL time.Duration
	// APIKey is sent as `X-API-Key` on /api/v1/* calls. Empty for clients
	// that only need to introspect iframe tokens.
	APIKey string

	mu    sync.Mutex
	cache map[string]cacheEntry
}

// WithAPIKey returns a sibling client carrying the given API key. The
// new client has its own introspection cache. Use this in main():
//
//	c := corp.New(host).WithAPIKey(os.Getenv("CORP_API_KEY"))
func (c *Client) WithAPIKey(key string) *Client {
	return &Client{
		BaseURL:    c.BaseURL,
		HTTPClient: c.HTTPClient,
		CacheTTL:   c.CacheTTL,
		APIKey:     key,
		cache:      map[string]cacheEntry{},
	}
}

type cacheEntry struct {
	user   *User
	expiry time.Time
}

// New creates a Client pointed at the given corp-ui base URL (no trailing slash).
func New(baseURL string) *Client {
	return &Client{
		BaseURL:    strings.TrimRight(baseURL, "/"),
		HTTPClient: &http.Client{Timeout: 5 * time.Second},
		CacheTTL:   30 * time.Second,
		cache:      map[string]cacheEntry{},
	}
}

// ErrInactive is returned when introspection succeeds HTTP-wise but the token
// is rejected (expired, revoked, malformed).
var ErrInactive = errors.New("corp: token inactive")

// Introspect calls /api/iframe/introspect and returns the parsed user.
func (c *Client) Introspect(ctx context.Context, token string) (*User, error) {
	if token == "" {
		return nil, ErrInactive
	}
	if c.CacheTTL > 0 {
		c.mu.Lock()
		if entry, ok := c.cache[token]; ok && time.Now().Before(entry.expiry) {
			c.mu.Unlock()
			return entry.user, nil
		}
		c.mu.Unlock()
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.BaseURL+"/api/iframe/introspect", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := c.HTTPClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("corp introspect: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		return nil, fmt.Errorf("corp introspect: http %d", resp.StatusCode)
	}
	var raw struct {
		Active bool `json:"active"`
		User
	}
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		return nil, fmt.Errorf("corp introspect decode: %w", err)
	}
	if !raw.Active {
		return nil, ErrInactive
	}
	user := raw.User
	if c.CacheTTL > 0 {
		ttl := c.CacheTTL
		// Don't cache past the token's own expiry.
		if user.ExpiresAt > 0 {
			until := time.Until(time.Unix(user.ExpiresAt, 0))
			if until < ttl {
				ttl = until
			}
		}
		if ttl > 0 {
			c.mu.Lock()
			c.cache[token] = cacheEntry{user: &user, expiry: time.Now().Add(ttl)}
			c.mu.Unlock()
		}
	}
	return &user, nil
}

type ctxKey struct{}

// UserFromContext returns the validated user attached by Middleware.
func UserFromContext(ctx context.Context) (*User, bool) {
	u, ok := ctx.Value(ctxKey{}).(*User)
	return u, ok
}

// Middleware validates the Bearer token on every request, calling Introspect
// (with cache). Unauthenticated or rejected requests get 401.
func (c *Client) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token := bearerFrom(r)
		if token == "" {
			http.Error(w, "missing bearer token", http.StatusUnauthorized)
			return
		}
		user, err := c.Introspect(r.Context(), token)
		if err != nil {
			http.Error(w, "invalid token", http.StatusUnauthorized)
			return
		}
		ctx := context.WithValue(r.Context(), ctxKey{}, user)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// RequirePerm wraps a handler so it only runs when the caller has access
// (level "r"|"w"|"a") on the given permission key.
func RequirePerm(key, level string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		u, ok := UserFromContext(r.Context())
		if !ok || !u.Can(key, level) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func bearerFrom(r *http.Request) string {
	h := r.Header.Get("Authorization")
	if strings.HasPrefix(h, "Bearer ") {
		return strings.TrimPrefix(h, "Bearer ")
	}
	return ""
}

// --- Server-to-server helpers (require Client.APIKey to be set) ---

// UserPublic is the shape returned by /api/v1/users/* — just enough for
// modules to look up users by id, email, username or account_id.
type UserPublic struct {
	ID uint `json:"id"`
	// Email may be empty: corp supports users that sign in by username
	// only. Treat empty Email as "no email on file" rather than an error.
	Email string `json:"email"`
	// Username is the alternative login identifier (lowercased). Empty for
	// users registered with email only.
	Username      string            `json:"username"`
	DisplayName   string            `json:"display_name"`
	AccountID     string            `json:"account_id"`
	Locale        string            `json:"locale"`
	IsAdmin       bool              `json:"is_admin"`
	IsActive      bool              `json:"is_active"`
	EmailVerified bool              `json:"email_verified"`
	// TotpEnabled is true once the user has finished TOTP enrollment in /me;
	// the login flow demands a code on subsequent sign-ins. Read-only from
	// modules — there's no SDK method to enable/disable, by design.
	TotpEnabled   bool              `json:"totp_enabled"`
	Groups        []GroupPublic     `json:"groups,omitempty"`
	Metadata      map[string]string `json:"metadata,omitempty"`
}

// Identifier returns the most user-recognizable identity string for a user —
// preferring email, then "@username", then "user-<id>". Useful for log lines
// and audit trails so accounts without email still print something readable.
func (u *UserPublic) Identifier() string {
	if u == nil {
		return ""
	}
	if u.Email != "" {
		return u.Email
	}
	if u.Username != "" {
		return "@" + u.Username
	}
	return fmt.Sprintf("user-%d", u.ID)
}

// GroupPublic is the shape returned by /api/v1/groups/{id}.
type GroupPublic struct {
	ID          uint         `json:"id"`
	Name        string       `json:"name"`
	Description string       `json:"description"`
	Users       []UserPublic `json:"users,omitempty"`
}

// ErrNoAPIKey is returned when an s2s helper is called but Client.APIKey is empty.
var ErrNoAPIKey = errors.New("corp: API key not configured (use Client.WithAPIKey)")

// ErrNoIdentifier is returned when CreateUser is called with both Email and
// Username empty — corp needs at least one identifier to log the user in.
var ErrNoIdentifier = errors.New("corp: CreateUser needs at least Email or Username")

// GetUser fetches a user by their corp id.
func (c *Client) GetUser(ctx context.Context, id uint) (*UserPublic, error) {
	var u UserPublic
	if err := c.s2sJSON(ctx, fmt.Sprintf("/api/v1/users/%d", id), &u); err != nil {
		return nil, err
	}
	return &u, nil
}

// FindUserByAccountID looks up a user by the admin-set account_id field.
func (c *Client) FindUserByAccountID(ctx context.Context, accountID string) (*UserPublic, error) {
	var u UserPublic
	q := url.Values{"account_id": []string{accountID}}
	if err := c.s2sJSON(ctx, "/api/v1/users?"+q.Encode(), &u); err != nil {
		return nil, err
	}
	return &u, nil
}

// ListUsersOpts narrows + paginates GET /api/v1/users/list. Empty AccountIDs
// returns the full user list (paginated). Limit defaults to 50, capped at 200
// server-side; AccountIDs is capped at 200 per call.
type ListUsersOpts struct {
	Limit      int
	Offset     int
	AccountIDs []string
}

// UserListResponse is the page envelope for ListUsers / FindUsersByAccountIDs.
type UserListResponse struct {
	Items  []UserPublic `json:"items"`
	Total  int64        `json:"total"`
	Limit  int          `json:"limit"`
	Offset int          `json:"offset"`
}

// ListUsers returns a paginated list, optionally filtered by account_id.
func (c *Client) ListUsers(ctx context.Context, opts ListUsersOpts) (*UserListResponse, error) {
	q := url.Values{}
	if opts.Limit > 0 {
		q.Set("limit", strconv.Itoa(opts.Limit))
	}
	if opts.Offset > 0 {
		q.Set("offset", strconv.Itoa(opts.Offset))
	}
	if len(opts.AccountIDs) > 0 {
		q.Set("account_ids", strings.Join(opts.AccountIDs, ","))
	}
	path := "/api/v1/users/list"
	if enc := q.Encode(); enc != "" {
		path += "?" + enc
	}
	var resp UserListResponse
	if err := c.s2sJSON(ctx, path, &resp); err != nil {
		return nil, err
	}
	return &resp, nil
}

// FindUsersByAccountIDs is a convenience wrapper around ListUsers that returns
// only the matching users (no pagination envelope) for the given IDs. The
// returned slice can be shorter than the input if some IDs have no user.
// Caller is responsible for batching when len(ids) > 200.
func (c *Client) FindUsersByAccountIDs(ctx context.Context, ids []string) ([]UserPublic, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	resp, err := c.ListUsers(ctx, ListUsersOpts{AccountIDs: ids, Limit: len(ids)})
	if err != nil {
		return nil, err
	}
	return resp.Items, nil
}

// FindUserByEmail looks up a user by exact email.
func (c *Client) FindUserByEmail(ctx context.Context, email string) (*UserPublic, error) {
	var u UserPublic
	q := url.Values{"email": []string{email}}
	if err := c.s2sJSON(ctx, "/api/v1/users?"+q.Encode(), &u); err != nil {
		return nil, err
	}
	return &u, nil
}

// GetGroup fetches a group with its members.
func (c *Client) GetGroup(ctx context.Context, id uint) (*GroupPublic, error) {
	var g GroupPublic
	if err := c.s2sJSON(ctx, fmt.Sprintf("/api/v1/groups/%d", id), &g); err != nil {
		return nil, err
	}
	return &g, nil
}

func (c *Client) s2sJSON(ctx context.Context, path string, out any) error {
	return c.s2sCall(ctx, http.MethodGet, path, nil, out)
}

// MetadataEntry is a single user-metadata KV used at user-creation time.
type MetadataEntry struct {
	Key        string `json:"key"`
	Value      string `json:"value"`
	Visibility string `json:"visibility,omitempty"` // "admin" | "all" | "iframe"; empty defaults to admin
}

// CreateUserInput captures the fields for POST /api/v1/users.
//
// At least one of Email or Username must be set — corp supports both
// kinds of accounts. Empty Password makes corp-ui generate a random
// one; your module should then trigger /auth/forgot-password (email-bearing
// users) or hand the user a password the admin can also reset later
// (username-only users).
type CreateUserInput struct {
	// Email is optional when Username is set. Lowercased server-side.
	Email string `json:"email,omitempty"`
	// Username is optional when Email is set. Lowercased server-side.
	// Use this for service-account-style logins or accounts whose owner
	// doesn't have a usable email address.
	Username      string          `json:"username,omitempty"`
	Password      string          `json:"password,omitempty"`
	DisplayName   string          `json:"display_name,omitempty"`
	AccountID     string          `json:"account_id,omitempty"`
	Locale        string          `json:"locale,omitempty"`
	IsActive      *bool           `json:"is_active,omitempty"`
	EmailVerified *bool           `json:"email_verified,omitempty"`
	GroupIDs      []uint          `json:"group_ids,omitempty"`
	Metadata      []MetadataEntry `json:"metadata,omitempty"`
}

// CreateUser provisions a new user. Requires the API key to have the
// "manage users" capability (Settings → Services → Can manage users), or the
// global key. Returns ErrNoIdentifier if both Email and Username are empty —
// corp needs at least one to make the account loginable.
func (c *Client) CreateUser(ctx context.Context, in CreateUserInput) (*UserPublic, error) {
	if in.Email == "" && in.Username == "" {
		return nil, ErrNoIdentifier
	}
	var u UserPublic
	if err := c.s2sCall(ctx, http.MethodPost, "/api/v1/users", in, &u); err != nil {
		return nil, err
	}
	return &u, nil
}

// CreateUserWithLogin is a thin shortcut for the common "no email, just a
// login" case — service accounts, batch-imported users, anyone whose only
// way to sign in is by username + password. Equivalent to:
//
//	c.CreateUser(ctx, CreateUserInput{Username: u, Password: pw, AccountID: acct, ...})
//
// You can extend the call by mutating `extra` before passing it in.
func (c *Client) CreateUserWithLogin(ctx context.Context, username, password string, extra CreateUserInput) (*UserPublic, error) {
	if username == "" {
		return nil, ErrNoIdentifier
	}
	extra.Username = username
	extra.Password = password
	return c.CreateUser(ctx, extra)
}

// FindUserByUsername resolves a user by their lowercased username. Returns
// the standard 404-wrapped error from s2sCall if no such user exists.
func (c *Client) FindUserByUsername(ctx context.Context, username string) (*UserPublic, error) {
	var u UserPublic
	q := url.Values{"username": []string{username}}
	if err := c.s2sJSON(ctx, "/api/v1/users?"+q.Encode(), &u); err != nil {
		return nil, err
	}
	return &u, nil
}

// emailRE is a forgiving "looks like an email" check — local@domain.tld with
// no whitespace and at least one dot in the domain. We don't try to validate
// against RFC 5321; the goal is just to disambiguate "alice" (username) from
// "alice@example.com" (email) in a single user-facing input.
var emailRE = regexp.MustCompile(`^[^@\s]+@[^@\s]+\.[^@\s]+$`)

// LooksLikeEmail returns true when `identifier` matches a permissive
// email pattern. Use it to drive a single "Email or login" form field
// in your module's UI:
//
//	if corp.LooksLikeEmail(input) { /* treat as email */ }
//	else                              { /* treat as username */ }
func LooksLikeEmail(identifier string) bool {
	return emailRE.MatchString(strings.TrimSpace(identifier))
}

// FindUserByIdentifier accepts a single string and routes it to either
// FindUserByEmail or FindUserByUsername based on shape. Saves your module
// from having two separate inputs / two separate code paths when it just
// wants to look up "the user the human typed in".
func (c *Client) FindUserByIdentifier(ctx context.Context, identifier string) (*UserPublic, error) {
	id := strings.TrimSpace(identifier)
	if id == "" {
		return nil, ErrNoIdentifier
	}
	if LooksLikeEmail(id) {
		return c.FindUserByEmail(ctx, id)
	}
	return c.FindUserByUsername(ctx, id)
}

// CreateUserWithIdentifier mirrors FindUserByIdentifier for provisioning:
// pass a single string (email-shaped → Email, anything else → Username).
// Useful when your module has a single "Login" form field and doesn't want
// to ask the user to pick the kind upfront.
//
//	c.CreateUserWithIdentifier(ctx, "alice@example.com", "pw", extra)
//	  → CreateUserInput{Email: "alice@example.com", Password: "pw", ...}
//
//	c.CreateUserWithIdentifier(ctx, "ops-bot", "pw", extra)
//	  → CreateUserInput{Username: "ops-bot", Password: "pw", ...}
func (c *Client) CreateUserWithIdentifier(ctx context.Context, identifier, password string, extra CreateUserInput) (*UserPublic, error) {
	id := strings.TrimSpace(identifier)
	if id == "" {
		return nil, ErrNoIdentifier
	}
	if LooksLikeEmail(id) {
		extra.Email = id
	} else {
		extra.Username = id
	}
	extra.Password = password
	return c.CreateUser(ctx, extra)
}

// UpdateUserInput is the patch body for PATCH /api/v1/users/{id}. Only fields
// you want to change should be set (use the helper pointer constructors).
type UpdateUserInput struct {
	DisplayName   *string `json:"display_name,omitempty"`
	AccountID     *string `json:"account_id,omitempty"`
	Locale        *string `json:"locale,omitempty"`
	IsActive      *bool   `json:"is_active,omitempty"`
	EmailVerified *bool   `json:"email_verified,omitempty"`
}

// UpdateUser patches a subset of user fields. Email and password are
// intentionally not mutable via s2s — that goes through the auth flow.
func (c *Client) UpdateUser(ctx context.Context, id uint, in UpdateUserInput) (*UserPublic, error) {
	var u UserPublic
	if err := c.s2sCall(ctx, http.MethodPatch, fmt.Sprintf("/api/v1/users/%d", id), in, &u); err != nil {
		return nil, err
	}
	return &u, nil
}

// SetUserMetadata upserts a single KV. Visibility defaults to "admin" when
// empty — pass "all" to expose to /api/me, "iframe" to embed in iframe tokens.
func (c *Client) SetUserMetadata(ctx context.Context, userID uint, key, value, visibility string) error {
	body := map[string]string{"key": key, "value": value}
	if visibility != "" {
		body["visibility"] = visibility
	}
	return c.s2sCall(ctx, http.MethodPut, fmt.Sprintf("/api/v1/users/%d/metadata", userID), body, nil)
}

// DeleteUserMetadata removes one KV by key.
func (c *Client) DeleteUserMetadata(ctx context.Context, userID uint, key string) error {
	q := url.Values{"key": []string{key}}
	return c.s2sCall(ctx, http.MethodDelete,
		fmt.Sprintf("/api/v1/users/%d/metadata?%s", userID, q.Encode()), nil, nil)
}

// AddUserToGroup attaches the user to the group. Idempotent.
func (c *Client) AddUserToGroup(ctx context.Context, userID, groupID uint) error {
	return c.s2sCall(ctx, http.MethodPost,
		fmt.Sprintf("/api/v1/users/%d/groups/%d", userID, groupID), nil, nil)
}

// RemoveUserFromGroup detaches the user from the group. Idempotent.
func (c *Client) RemoveUserFromGroup(ctx context.Context, userID, groupID uint) error {
	return c.s2sCall(ctx, http.MethodDelete,
		fmt.Sprintf("/api/v1/users/%d/groups/%d", userID, groupID), nil, nil)
}

// Ptr returns a pointer to v — handy for the *bool / *string fields on
// UpdateUserInput / CreateUserInput.
//
//	in := corp.UpdateUserInput{IsActive: corp.Ptr(false)}
func Ptr[T any](v T) *T { return &v }

// s2sCall is the shared HTTP wrapper. body may be nil; out may be nil for
// 2xx-no-content endpoints. Returns a descriptive error including the path.
func (c *Client) s2sCall(ctx context.Context, method, path string, body, out any) error {
	if c.APIKey == "" {
		return ErrNoAPIKey
	}
	var bodyReader io.Reader
	if body != nil {
		buf, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("corp s2s %s: marshal: %w", path, err)
		}
		bodyReader = bytes.NewReader(buf)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.BaseURL+path, bodyReader)
	if err != nil {
		return err
	}
	req.Header.Set("X-API-Key", c.APIKey)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.HTTPClient.Do(req)
	if err != nil {
		return fmt.Errorf("corp s2s %s: %w", path, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusUnauthorized {
		return fmt.Errorf("corp s2s %s: 401 — invalid or revoked API key", path)
	}
	if resp.StatusCode == http.StatusForbidden {
		return fmt.Errorf("corp s2s %s: 403 — api key not allowed (set 'Can manage users' in admin)", path)
	}
	if resp.StatusCode == http.StatusNotFound {
		return fmt.Errorf("corp s2s %s: 404", path)
	}
	if resp.StatusCode/100 != 2 {
		// Try to surface the server-provided error message.
		raw, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("corp s2s %s: http %d: %s", path, resp.StatusCode, strings.TrimSpace(string(raw)))
	}
	if out == nil || resp.StatusCode == http.StatusNoContent {
		return nil
	}
	return json.NewDecoder(resp.Body).Decode(out)
}
