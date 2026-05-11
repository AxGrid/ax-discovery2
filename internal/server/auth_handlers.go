package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/corp-ui/corp-ui/sdk/go/corp"

	"github.com/axgrid/discovery2/internal/auth"
	"github.com/axgrid/discovery2/internal/model"
	"github.com/axgrid/discovery2/internal/store"
)

type loginRequest struct {
	Identifier string `json:"identifier"` // email OR username
	Username   string `json:"username"`   // accepted as alias for back-compat
	Password   string `json:"password"`
}

type meResponse struct {
	Authenticated bool              `json:"authenticated"`
	UserID        string            `json:"userId,omitempty"`
	Username      string            `json:"username,omitempty"`
	Email         string            `json:"email,omitempty"`
	DisplayName   string            `json:"displayName,omitempty"`
	AccountID     string            `json:"accountId,omitempty"`
	IsAdmin       bool              `json:"isAdmin,omitempty"`
	System        bool              `json:"system,omitempty"`
	Role          string            `json:"role"`
	Perms         map[string]string `json:"perms,omitempty"`
	Iframe        bool              `json:"iframe,omitempty"`
}

// login is the standalone-mode entry point. It posts the user's credentials
// to corp-ui's verify-password endpoint and mints our own session cookie on
// success. Iframe-token requests do NOT go through this handler — they
// arrive with a Bearer token that's introspected per-request.
func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	// Brute-force defense — corp-ui doesn't lock out per-service.
	if !s.loginRates.allow(clientIP(r)) {
		writeErr(w, http.StatusTooManyRequests, errors.New("too many attempts, slow down"))
		return
	}

	var req loginRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	identifier := strings.TrimSpace(req.Identifier)
	if identifier == "" {
		identifier = strings.TrimSpace(req.Username)
	}
	if identifier == "" || req.Password == "" {
		writeErr(w, http.StatusBadRequest, errors.New("identifier and password required"))
		return
	}

	corpClient := s.resolver.CorpClient()
	if corpClient == nil {
		writeErr(w, http.StatusServiceUnavailable,
			errors.New("corp-ui auth not configured on this server"))
		return
	}

	user, ok := verifyPassword(r.Context(), corpClient,
		s.resolver.CorpServiceSlug(), identifier, req.Password)
	if !ok {
		// Constant-ish-time failure delay to flatten user-existence timing.
		time.Sleep(150 * time.Millisecond)
		_ = s.store.AppendAudit(model.AuditEntry{
			ActorID:    "anonymous",
			ActorName:  "anonymous",
			Action:     model.AuditLoginFailed,
			Target:     identifier,
			TargetType: "user",
			Details:    map[string]interface{}{"ip": clientIP(r)},
		})
		writeErr(w, http.StatusUnauthorized, errors.New("invalid credentials"))
		return
	}

	snapshot := &model.Session{
		UserID:      user.UserID,
		Email:       user.Email,
		Username:    user.Username,
		DisplayName: user.DisplayName,
		AccountID:   user.AccountID,
		IsAdmin:     user.IsAdmin,
		Perms:       user.Perms,
	}
	if snapshot.DisplayName == "" {
		if snapshot.Email != "" {
			snapshot.DisplayName = snapshot.Email
		} else {
			snapshot.DisplayName = snapshot.Username
		}
	}

	tok, expires, err := auth.IssueSession(s.store, snapshot)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	auth.SetSessionCookie(w, tok, expires, isHTTPS(r))

	_ = s.store.AppendAudit(model.AuditEntry{
		ActorID:    snapshot.UserID,
		ActorName:  snapshot.DisplayName,
		Action:     model.AuditUserLogin,
		Target:     snapshot.UserID,
		TargetType: "user",
		Details: map[string]interface{}{
			"email":    snapshot.Email,
			"username": snapshot.Username,
		},
	})

	writeJSON(w, http.StatusOK, meResponseFromSession(snapshot, false))
}

func (s *Server) logout(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie(auth.SessionCookie); err == nil && c.Value != "" {
		_ = s.store.DeleteSession(c.Value)
	}
	auth.ClearSessionCookie(w)

	id := auth.IdentityFrom(r.Context())
	if id.UserID != "" {
		s.audit(r, model.AuditUserLogout, id.UserID, "user", nil)
	}
	w.WriteHeader(http.StatusNoContent)
}

// me returns the current identity. Useful for the UI to know if there's a
// session and what the user can do.
func (s *Server) me(w http.ResponseWriter, r *http.Request) {
	id := auth.IdentityFrom(r.Context())
	writeJSON(w, http.StatusOK, meResponse{
		Authenticated: id.UserID != "" || id.System,
		UserID:        id.UserID,
		Username:      id.Username,
		Email:         id.Email,
		DisplayName:   id.DisplayName,
		AccountID:     id.AccountID,
		IsAdmin:       id.IsAdmin,
		System:        id.System,
		Role:          id.Role.String(),
		Perms:         id.Perms,
		Iframe:        isIframeBearer(r) && id.UserID != "",
	})
}

// searchCorpUsers proxies a lookup against corp-ui so the grants editor
// can autocomplete usernames/emails without exposing the corp-ui API key
// to the browser. Admin-only.
func (s *Server) searchCorpUsers(w http.ResponseWriter, r *http.Request) {
	if !requireAdmin(w, r) {
		return
	}
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if q == "" {
		writeJSON(w, http.StatusOK, []corpUserHit{})
		return
	}
	c := s.resolver.CorpClient()
	if c == nil {
		writeErr(w, http.StatusServiceUnavailable, errors.New("corp-ui auth not configured"))
		return
	}
	u, err := c.FindUserByIdentifier(r.Context(), q)
	if err != nil {
		// 404 from corp = empty list, not error.
		writeJSON(w, http.StatusOK, []corpUserHit{})
		return
	}
	writeJSON(w, http.StatusOK, []corpUserHit{{
		ID:          stringifyUint(u.ID),
		Email:       u.Email,
		Username:    u.Username,
		DisplayName: u.DisplayName,
		AccountID:   u.AccountID,
	}})
}

type corpUserHit struct {
	ID          string `json:"id"`
	Email       string `json:"email,omitempty"`
	Username    string `json:"username,omitempty"`
	DisplayName string `json:"displayName,omitempty"`
	AccountID   string `json:"accountId,omitempty"`
}

// audit is a small helper to record a single event.
func (s *Server) audit(r *http.Request, action, target, targetType string, details map[string]interface{}) {
	id := auth.IdentityFrom(r.Context())
	_ = s.store.AppendAudit(model.AuditEntry{
		ActorID:    id.ActorID(),
		ActorName:  id.ActorName(),
		Action:     action,
		Target:     target,
		TargetType: targetType,
		Details:    details,
	})
}

func isHTTPS(r *http.Request) bool {
	if r.TLS != nil {
		return true
	}
	if h := r.Header.Get("X-Forwarded-Proto"); strings.EqualFold(h, "https") {
		return true
	}
	return false
}

func isIframeBearer(r *http.Request) bool {
	return strings.HasPrefix(strings.ToLower(r.Header.Get("Authorization")), "bearer ")
}

func clientIP(r *http.Request) string {
	if h := r.Header.Get("X-Forwarded-For"); h != "" {
		if i := strings.IndexByte(h, ','); i > 0 {
			return strings.TrimSpace(h[:i])
		}
		return strings.TrimSpace(h)
	}
	if h := r.Header.Get("X-Real-IP"); h != "" {
		return strings.TrimSpace(h)
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// requireAdmin enforces the admin flag on the caller. Lives in auth_handlers
// because both audit and corp-user search depend on it.
func requireAdmin(w http.ResponseWriter, r *http.Request) bool {
	id := auth.IdentityFrom(r.Context())
	if id.IsAdmin || (id.System && id.Role >= auth.RoleAdmin) {
		return true
	}
	writeErr(w, http.StatusForbidden, errors.New("admin required"))
	return false
}

// safeStoreErr maps a store error to an HTTP code, hiding internal details.
func safeStoreErr(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, store.ErrNotFound):
		writeErr(w, http.StatusNotFound, err)
	case errors.Is(err, store.ErrConflict):
		writeErr(w, http.StatusConflict, err)
	default:
		writeErr(w, http.StatusInternalServerError, err)
	}
}

// --- corp-ui verify-password ---

// verifyPasswordResponse is the JSON shape returned by corp-ui's
// /api/v1/auth/verify-password. We don't pull in the corp SDK for this
// because the SDK doesn't expose verify-password as a helper (it's a
// password-handling path that wants to live in the host module, not the
// shared client).
type verifyPasswordResponse struct {
	Active      bool              `json:"active"`
	UserID      uint              `json:"user_id"`
	Email       string            `json:"email"`
	Username    string            `json:"username"`
	DisplayName string            `json:"display_name"`
	IsAdmin     bool              `json:"is_admin"`
	ServiceID   uint              `json:"service_id"`
	Slug        string            `json:"slug"`
	Perms       map[string]string `json:"perms"`
	AccountID   string            `json:"account_id"`
	Locale      string            `json:"locale"`
	Metadata    map[string]string `json:"metadata"`
}

type verifiedUser struct {
	UserID      string
	Email       string
	Username    string
	DisplayName string
	AccountID   string
	IsAdmin     bool
	Perms       map[string]string
}

// verifyPassword posts the credentials to corp-ui and returns the resolved
// user. ok=false means "treat as invalid credentials" for any reason —
// wrong password, unknown user, inactive, network blip, anything. We
// intentionally don't surface the reason to the caller (it's logged via
// the audit trail with the actual cause).
//
// The corp SDK doesn't expose verify-password as a typed helper (it's a
// password-handling path that's kept module-local on purpose), so we
// reach into Client.{BaseURL, APIKey, HTTPClient} and roll our own HTTP
// call.
func verifyPassword(ctx context.Context, c *corp.Client, slug, identifier, password string) (verifiedUser, bool) {
	if c == nil || c.APIKey == "" {
		return verifiedUser{}, false
	}
	body, _ := json.Marshal(map[string]string{
		"identifier":   identifier,
		"password":     password,
		"service_slug": slug,
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		strings.TrimRight(c.BaseURL, "/")+"/api/v1/auth/verify-password",
		bytes.NewReader(body))
	if err != nil {
		return verifiedUser{}, false
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-API-Key", c.APIKey)
	httpClient := c.HTTPClient
	if httpClient == nil {
		httpClient = http.DefaultClient
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return verifiedUser{}, false
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		_, _ = io.Copy(io.Discard, resp.Body)
		return verifiedUser{}, false
	}
	var v verifyPasswordResponse
	if err := json.NewDecoder(resp.Body).Decode(&v); err != nil {
		return verifiedUser{}, false
	}
	if !v.Active {
		return verifiedUser{}, false
	}
	if slug != "" && v.Slug != "" && v.Slug != slug {
		return verifiedUser{}, false
	}
	return verifiedUser{
		UserID:      stringifyUint(v.UserID),
		Email:       v.Email,
		Username:    v.Username,
		DisplayName: v.DisplayName,
		AccountID:   v.AccountID,
		IsAdmin:     v.IsAdmin,
		Perms:       v.Perms,
	}, true
}

func stringifyUint(n uint) string {
	if n == 0 {
		return ""
	}
	const digits = "0123456789"
	if n < 10 {
		return string(digits[n])
	}
	buf := make([]byte, 0, 20)
	for n > 0 {
		buf = append([]byte{digits[n%10]}, buf...)
		n /= 10
	}
	return string(buf)
}

func meResponseFromSession(snap *model.Session, iframe bool) meResponse {
	return meResponse{
		Authenticated: true,
		UserID:        snap.UserID,
		Username:      snap.Username,
		Email:         snap.Email,
		DisplayName:   snap.DisplayName,
		AccountID:     snap.AccountID,
		IsAdmin:       snap.IsAdmin,
		Role:          auth.RoleFromPerms(snap.IsAdmin, snap.Perms, "discovery").String(),
		Perms:         snap.Perms,
		Iframe:        iframe,
	}
}
