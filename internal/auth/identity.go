package auth

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"net/http"
	"strings"
	"time"

	"github.com/corp-ui/corp-ui/sdk/go/corp"

	"github.com/axgrid/discovery2/internal/model"
	"github.com/axgrid/discovery2/internal/store"
)

// SessionCookie is the HTTP cookie name used for browser sessions.
const SessionCookie = "discovery_session"

// SessionTTL controls how long a freshly-issued cookie session lasts.
//
// Sessions carry a snapshot of corp-ui perms taken at login time. A short
// TTL is the only thing that bounds how stale a corp-ui group/permission
// change can be. 15 min is a reasonable balance — long enough that
// operators aren't re-typing passwords all day, short enough that a "kick
// this user out" in corp-ui takes effect quickly.
const SessionTTL = 15 * time.Minute

// Identity describes who is making a request. Exactly one of UserID / System /
// Anonymous is meaningful, but Role is always set so handlers can short-circuit.
type Identity struct {
	UserID      string // corp-ui user_id stringified, or "" for system/anonymous
	Username    string
	Email       string
	DisplayName string
	AccountID   string
	IsAdmin     bool
	System      bool // true for static-token requests with no user attached
	Anonymous   bool
	Role        Role              // resolved permission level
	Perms       map[string]string // raw perms map from corp-ui ({"*": "rwa", "discovery": "rw", ...})
}

// ActorID returns the value to write into AuditEntry.ActorID.
func (i Identity) ActorID() string {
	switch {
	case i.UserID != "":
		return i.UserID
	case i.System:
		return "system"
	default:
		return "anonymous"
	}
}

// ActorName returns a human-readable label for audit logs.
func (i Identity) ActorName() string {
	switch {
	case i.DisplayName != "":
		return i.DisplayName
	case i.Email != "":
		return i.Email
	case i.Username != "":
		return i.Username
	case i.System:
		return "system (static token)"
	default:
		return "anonymous"
	}
}

type identityKey struct{}

// IdentityFrom returns the Identity stored in ctx, or a zero-valued anonymous one.
func IdentityFrom(ctx context.Context) Identity {
	if v, ok := ctx.Value(identityKey{}).(Identity); ok {
		return v
	}
	return Identity{Anonymous: true, Role: RoleNone}
}

// CorpConfig configures the corp-ui integration. ServiceSlug is the slug of
// the discovery service in corp-ui's admin — used as the s2s tenant when
// calling verify-password. When Client is nil, corp-ui auth is disabled
// (only static tokens work, useful for tests).
type CorpConfig struct {
	Client      *corp.Client
	ServiceSlug string
	PermKey     string // discovery permission key in corp-ui (default "discovery")
}

// Resolver decides who's calling. It checks (in order):
//  1. session cookie → cached corp-ui user
//  2. static token (Bearer / X-API-Token / ?token=) → system identity
//  3. iframe bearer token → corp-ui introspect → user identity
//  4. otherwise anonymous (with optional read role)
type Resolver struct {
	store         *store.Store
	authenticator *Authenticator
	corp          CorpConfig
}

// NewResolver wires identity resolution together.
func NewResolver(s *store.Store, a *Authenticator, c CorpConfig) *Resolver {
	if c.PermKey == "" {
		c.PermKey = "discovery"
	}
	return &Resolver{store: s, authenticator: a, corp: c}
}

// CorpClient is exposed for handlers that need to call s2s endpoints
// (verify-password on login, user lookups on grants).
func (r *Resolver) CorpClient() *corp.Client { return r.corp.Client }

// CorpServiceSlug is the slug expected in verify-password / introspect responses.
func (r *Resolver) CorpServiceSlug() string { return r.corp.ServiceSlug }

// CorpPermKey is the corp-ui permission key gating discovery actions.
func (r *Resolver) CorpPermKey() string { return r.corp.PermKey }

// Resolve inspects the incoming request and returns the caller identity.
func (r *Resolver) Resolve(req *http.Request) Identity {
	// 1. Session cookie — standalone browser login.
	if c, err := req.Cookie(SessionCookie); err == nil && c.Value != "" {
		if sess, err := r.store.GetSession(c.Value); err == nil {
			id := IdentityFromSession(sess, r.corp.PermKey)
			return id
		}
	}
	// 2./3. Bearer token: try static first (s2s tokens), then corp-ui iframe.
	token := extractToken(req)
	if token != "" {
		if role := r.authenticator.Resolve(token); role != RoleNone {
			return Identity{System: true, Role: role}
		}
		// Dynamic client tokens minted via the UI (store-backed). Checked after
		// the static env tokens so an env token can't be shadowed.
		if r.store != nil {
			if ct, err := r.store.GetClientToken(token); err == nil {
				if role := RoleFromString(ct.Role); role != RoleNone {
					return Identity{System: true, Role: role}
				}
			}
		}
		if r.corp.Client != nil {
			if user, err := r.corp.Client.Introspect(req.Context(), token); err == nil {
				return IdentityFromCorp(user, r.corp.ServiceSlug, r.corp.PermKey)
			}
		}
	}
	// 4. Anonymous
	role := r.authenticator.Resolve("") // honors AllowAnonymousRead
	return Identity{Anonymous: true, Role: role}
}

// Middleware attaches the resolved Identity to ctx and enforces a minimum role.
// If min == RoleNone, the handler is reached even when Resolve returns no role.
func (r *Resolver) Middleware(min Role, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		id := r.Resolve(req)
		if id.Role < min {
			w.Header().Set("WWW-Authenticate", `Bearer realm="discovery"`)
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		ctx := context.WithValue(req.Context(), identityKey{}, id)
		next.ServeHTTP(w, req.WithContext(ctx))
	})
}

// IdentityFromSession builds an Identity from a cached browser session.
func IdentityFromSession(sess *model.Session, permKey string) Identity {
	id := Identity{
		UserID:      sess.UserID,
		Username:    sess.Username,
		Email:       sess.Email,
		DisplayName: sess.DisplayName,
		AccountID:   sess.AccountID,
		IsAdmin:     sess.IsAdmin,
		Perms:       sess.Perms,
		Role:        RoleFromPerms(sess.IsAdmin, sess.Perms, permKey),
	}
	return id
}

// IdentityFromCorp builds an Identity from a corp-ui introspect response.
// It double-checks the iframe-token's service slug matches what discovery is
// registered as in corp-ui — a token issued for a different module must not
// grant access here.
func IdentityFromCorp(u *corp.User, expectSlug, permKey string) Identity {
	if u == nil {
		return Identity{Anonymous: true, Role: RoleNone}
	}
	if expectSlug != "" && u.Slug != "" && u.Slug != expectSlug {
		return Identity{Anonymous: true, Role: RoleNone}
	}
	return Identity{
		UserID:      stringifyUserID(u.UserID),
		Email:       u.Email,
		Username:    u.Email, // corp-ui doesn't expose username separately in introspect; fallback to email
		DisplayName: u.Email,
		AccountID:   u.AccountID,
		IsAdmin:     u.IsAdmin,
		Perms:       u.Perms,
		Role:        RoleFromPerms(u.IsAdmin, u.Perms, permKey),
	}
}

// RoleFromPerms maps corp-ui's (is_admin, perms) into a discovery Role.
// Order: corp-admin → admin; *:a or <permKey>:a → admin; *:w → write; *:r → read.
func RoleFromPerms(isAdmin bool, perms map[string]string, permKey string) Role {
	if isAdmin {
		return RoleAdmin
	}
	level := func(k string) string { return strings.ToLower(perms[k]) }
	if strings.Contains(level("*"), "a") || strings.Contains(level(permKey), "a") {
		return RoleAdmin
	}
	if strings.Contains(level("*"), "w") || strings.Contains(level(permKey), "w") {
		return RoleWrite
	}
	if strings.Contains(level("*"), "r") || strings.Contains(level(permKey), "r") {
		return RoleRead
	}
	return RoleNone
}

func stringifyUserID(id uint) string {
	if id == 0 {
		return ""
	}
	// strconv.Itoa avoids fmt allocations on the hot path.
	const digits = "0123456789"
	if id < 10 {
		return string(digits[id])
	}
	buf := make([]byte, 0, 20)
	for id > 0 {
		buf = append([]byte{digits[id%10]}, buf...)
		id /= 10
	}
	return string(buf)
}

// --- helpers used elsewhere in the codebase ---

// NewSessionToken returns a 32-byte random hex string.
func NewSessionToken() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}

// IssueSession persists a session built from the corp-ui verify-password
// response and returns the freshly-minted cookie token plus its expiry.
func IssueSession(s *store.Store, snapshot *model.Session) (string, time.Time, error) {
	tok, err := NewSessionToken()
	if err != nil {
		return "", time.Time{}, err
	}
	expires := time.Now().Add(SessionTTL).UTC()
	sess := *snapshot
	sess.Token = tok
	sess.ExpiresAt = expires
	if err := s.PutSession(&sess); err != nil {
		return "", time.Time{}, err
	}
	return tok, expires, nil
}

// SetSessionCookie writes the auth cookie to the response.
func SetSessionCookie(w http.ResponseWriter, token string, expires time.Time, secure bool) {
	http.SetCookie(w, &http.Cookie{
		Name:     SessionCookie,
		Value:    token,
		Path:     "/",
		Expires:  expires,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   secure,
	})
}

// ClearSessionCookie tells the browser to drop the session cookie.
func ClearSessionCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name:     SessionCookie,
		Value:    "",
		Path:     "/",
		Expires:  time.Unix(0, 0),
		MaxAge:   -1,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
	})
}

// CanEditService is the canonical ACL check used by all service-mutating handlers.
func CanEditService(svc *model.Service, id Identity) bool {
	return svc.CanEdit(id.UserID, id.IsAdmin, id.System)
}
