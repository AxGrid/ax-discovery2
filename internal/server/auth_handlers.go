package server

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/axgrid/discovery2/internal/auth"
	"github.com/axgrid/discovery2/internal/model"
	"github.com/axgrid/discovery2/internal/store"
)

type loginRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

type loginResponse struct {
	User *model.User `json:"user"`
}

func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	var req loginRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	req.Username = strings.TrimSpace(req.Username)
	if req.Username == "" || req.Password == "" {
		writeErr(w, http.StatusBadRequest, errors.New("username and password required"))
		return
	}

	u, err := s.store.GetUserByUsername(req.Username)
	if err != nil {
		// Constant-time-ish: do not leak whether the user exists.
		writeErr(w, http.StatusUnauthorized, errors.New("invalid credentials"))
		return
	}
	if err := auth.CheckPassword(u.PasswordHash, req.Password); err != nil {
		writeErr(w, http.StatusUnauthorized, errors.New("invalid credentials"))
		return
	}

	tok, expires, err := auth.IssueSession(s.store, u.ID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	auth.SetSessionCookie(w, tok, expires, isHTTPS(r))

	// At login time the request context still holds the pre-login (anonymous)
	// identity, so attribute the audit entry directly to the user we just
	// authenticated rather than going through s.audit.
	actorName := u.DisplayName
	if actorName == "" {
		actorName = u.Username
	}
	_ = s.store.AppendAudit(model.AuditEntry{
		ActorID:    u.ID,
		ActorName:  actorName,
		Action:     model.AuditUserLogin,
		Target:     u.ID,
		TargetType: "user",
		Details:    map[string]interface{}{"username": u.Username},
	})

	out := *u
	out.PasswordHash = ""
	writeJSON(w, http.StatusOK, loginResponse{User: &out})
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
	type meResponse struct {
		Authenticated bool   `json:"authenticated"`
		UserID        string `json:"userId,omitempty"`
		Username      string `json:"username,omitempty"`
		DisplayName   string `json:"displayName,omitempty"`
		IsAdmin       bool   `json:"isAdmin,omitempty"`
		System        bool   `json:"system,omitempty"`
		Role          string `json:"role"`
	}
	writeJSON(w, http.StatusOK, meResponse{
		Authenticated: id.UserID != "" || id.System,
		UserID:        id.UserID,
		Username:      id.Username,
		DisplayName:   id.DisplayName,
		IsAdmin:       id.IsAdmin,
		System:        id.System,
		Role:          id.Role.String(),
	})
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
