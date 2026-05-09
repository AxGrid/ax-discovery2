package auth

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"net/http"
	"strings"
	"time"

	"golang.org/x/crypto/bcrypt"

	"github.com/axgrid/discovery2/internal/model"
	"github.com/axgrid/discovery2/internal/store"
)

// SessionCookie is the HTTP cookie name used for browser sessions.
const SessionCookie = "discovery_session"

// SessionTTL controls how long a freshly-issued cookie session lasts.
const SessionTTL = 30 * 24 * time.Hour

// Identity describes who is making a request. Exactly one of UserID / System /
// Anonymous is meaningful, but Role is always set so handlers can short-circuit.
type Identity struct {
	UserID      string
	Username    string
	DisplayName string
	IsAdmin     bool
	System      bool   // true for static-token requests with no user attached
	Anonymous   bool
	Role        Role   // resolved permission level
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

// Resolver decides who's calling. It checks (in order):
//  1. session cookie → user identity
//  2. Authorization: Bearer / X-API-Token / ?token= → user-token user, or static token (system)
//  3. otherwise anonymous (with optional read role)
type Resolver struct {
	store         *store.Store
	authenticator *Authenticator
}

// NewResolver wires identity resolution together.
func NewResolver(s *store.Store, a *Authenticator) *Resolver {
	return &Resolver{store: s, authenticator: a}
}

// Resolve inspects the incoming request and returns the caller identity.
func (r *Resolver) Resolve(req *http.Request) Identity {
	// 1. Session cookie
	if c, err := req.Cookie(SessionCookie); err == nil && c.Value != "" {
		if sess, err := r.store.GetSession(c.Value); err == nil {
			if u, err := r.store.GetUser(sess.UserID); err == nil {
				role := RoleWrite
				if u.IsAdmin {
					role = RoleAdmin
				}
				return Identity{
					UserID:      u.ID,
					Username:    u.Username,
					DisplayName: u.DisplayName,
					IsAdmin:     u.IsAdmin,
					Role:        role,
				}
			}
		}
	}
	// 2. Static token (system identity)
	token := extractToken(req)
	if token != "" {
		role := r.authenticator.Resolve(token)
		if role != RoleNone {
			return Identity{System: true, Role: role}
		}
	}
	// 3. Anonymous
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

// --- helpers used elsewhere in the codebase ---

// HashPassword bcrypts a plaintext password. Cost 12 is reasonable for 2026
// hardware: ~150ms per hash, brute-forcing 8-char passwords still costs years.
func HashPassword(plain string) (string, error) {
	if strings.TrimSpace(plain) == "" {
		return "", ErrInvalidPassword
	}
	h, err := bcrypt.GenerateFromPassword([]byte(plain), 12)
	if err != nil {
		return "", err
	}
	return string(h), nil
}

// CheckPassword returns nil if plain matches the stored bcrypt hash.
func CheckPassword(hash, plain string) error {
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(plain))
}

// NewSessionToken returns a 32-byte random hex string.
func NewSessionToken() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}

// IssueSession persists a session for the given user and returns the token.
func IssueSession(s *store.Store, userID string) (string, time.Time, error) {
	tok, err := NewSessionToken()
	if err != nil {
		return "", time.Time{}, err
	}
	expires := time.Now().Add(SessionTTL).UTC()
	if err := s.PutSession(&model.Session{
		Token:     tok,
		UserID:    userID,
		ExpiresAt: expires,
	}); err != nil {
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
