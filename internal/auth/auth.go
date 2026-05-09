package auth

import (
	"context"
	"crypto/subtle"
	"errors"
	"net/http"
	"strings"
)

// ErrInvalidPassword is returned when a password fails policy.
var ErrInvalidPassword = errors.New("invalid password")

type Role int

const (
	RoleNone Role = iota
	RoleRead
	RoleWrite
	RoleAdmin
)

func (r Role) String() string {
	switch r {
	case RoleRead:
		return "read"
	case RoleWrite:
		return "write"
	case RoleAdmin:
		return "admin"
	}
	return "none"
}

type Config struct {
	// If true, requests without a token are allowed with RoleRead.
	AllowAnonymousRead bool
	ReadTokens         []string
	WriteTokens        []string
	AdminTokens        []string
}

type Authenticator struct{ cfg Config }

func New(cfg Config) *Authenticator { return &Authenticator{cfg: cfg} }

type ctxKey struct{}

// RoleFrom returns the role attached to ctx by the legacy Middleware
// (kept for unit tests). Production paths use Resolver.Middleware which
// stores a full Identity instead.
func RoleFrom(ctx context.Context) Role {
	if id, ok := ctx.Value(identityKey{}).(Identity); ok {
		return id.Role
	}
	r, _ := ctx.Value(ctxKey{}).(Role)
	return r
}

// Resolve checks a raw token (without "Bearer ") against configured roles.
// Higher roles imply lower roles.
func (a *Authenticator) Resolve(token string) Role {
	if token == "" {
		if a.cfg.AllowAnonymousRead {
			return RoleRead
		}
		return RoleNone
	}
	if matchAny(token, a.cfg.AdminTokens) {
		return RoleAdmin
	}
	if matchAny(token, a.cfg.WriteTokens) {
		return RoleWrite
	}
	if matchAny(token, a.cfg.ReadTokens) {
		return RoleRead
	}
	return RoleNone
}

func matchAny(token string, list []string) bool {
	for _, t := range list {
		if t == "" {
			continue
		}
		if subtle.ConstantTimeCompare([]byte(token), []byte(t)) == 1 {
			return true
		}
	}
	return false
}

// Middleware enforces a minimum role for the wrapped handler.
func (a *Authenticator) Middleware(min Role, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token := extractToken(r)
		role := a.Resolve(token)
		if role < min {
			w.Header().Set("WWW-Authenticate", `Bearer realm="discovery"`)
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		ctx := context.WithValue(r.Context(), ctxKey{}, role)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func extractToken(r *http.Request) string {
	if h := r.Header.Get("Authorization"); h != "" {
		if strings.HasPrefix(strings.ToLower(h), "bearer ") {
			return strings.TrimSpace(h[7:])
		}
		return strings.TrimSpace(h)
	}
	if h := r.Header.Get("X-API-Token"); h != "" {
		return strings.TrimSpace(h)
	}
	if t := r.URL.Query().Get("token"); t != "" {
		return t
	}
	return ""
}
