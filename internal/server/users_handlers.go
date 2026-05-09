package server

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/google/uuid"

	"github.com/axgrid/discovery2/internal/auth"
	"github.com/axgrid/discovery2/internal/model"
)

type userRequest struct {
	Username    string `json:"username"`
	DisplayName string `json:"displayName"`
	Password    string `json:"password,omitempty"`
	IsAdmin     bool   `json:"isAdmin"`
}

func (s *Server) listUsers(w http.ResponseWriter, r *http.Request) {
	if !requireAdmin(w, r) {
		return
	}
	users, err := s.store.ListUsers()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	for i := range users {
		users[i].PasswordHash = ""
	}
	if users == nil {
		users = []model.User{}
	}
	writeJSON(w, http.StatusOK, users)
}

func (s *Server) createUser(w http.ResponseWriter, r *http.Request) {
	if !requireAdmin(w, r) {
		return
	}
	var req userRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	req.Username = strings.TrimSpace(req.Username)
	if req.Username == "" {
		writeErr(w, http.StatusBadRequest, errors.New("username required"))
		return
	}
	if req.Password == "" {
		writeErr(w, http.StatusBadRequest, errors.New("password required for new user"))
		return
	}
	hash, err := auth.HashPassword(req.Password)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	u := &model.User{
		ID:           uuid.NewString(),
		Username:     req.Username,
		DisplayName:  req.DisplayName,
		IsAdmin:      req.IsAdmin,
		PasswordHash: hash,
	}
	if err := s.store.PutUser(u); err != nil {
		safeStoreErr(w, err)
		return
	}
	s.audit(r, model.AuditUserCreated, u.ID, "user", map[string]interface{}{
		"username": u.Username,
		"isAdmin":  u.IsAdmin,
	})
	out := *u
	out.PasswordHash = ""
	writeJSON(w, http.StatusCreated, &out)
}

func (s *Server) updateUser(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	caller := auth.IdentityFrom(r.Context())
	// Admins can edit anyone; users can edit themselves.
	if !caller.IsAdmin && caller.UserID != id {
		writeErr(w, http.StatusForbidden, errors.New("admin or self required"))
		return
	}
	existing, err := s.store.GetUser(id)
	if err != nil {
		safeStoreErr(w, err)
		return
	}
	var req userRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	changes := map[string]interface{}{}
	if req.Username != "" && req.Username != existing.Username {
		existing.Username = strings.TrimSpace(req.Username)
		changes["username"] = existing.Username
	}
	if req.DisplayName != existing.DisplayName {
		existing.DisplayName = req.DisplayName
		changes["displayName"] = existing.DisplayName
	}
	// Only admins can flip the admin bit.
	if caller.IsAdmin && req.IsAdmin != existing.IsAdmin {
		existing.IsAdmin = req.IsAdmin
		changes["isAdmin"] = existing.IsAdmin
	}
	if req.Password != "" {
		hash, err := auth.HashPassword(req.Password)
		if err != nil {
			writeErr(w, http.StatusBadRequest, err)
			return
		}
		existing.PasswordHash = hash
		changes["password"] = "***"
	}
	if err := s.store.PutUser(existing); err != nil {
		safeStoreErr(w, err)
		return
	}
	s.audit(r, model.AuditUserUpdated, existing.ID, "user", changes)
	out := *existing
	out.PasswordHash = ""
	writeJSON(w, http.StatusOK, &out)
}

func (s *Server) deleteUser(w http.ResponseWriter, r *http.Request) {
	if !requireAdmin(w, r) {
		return
	}
	id := r.PathValue("id")
	caller := auth.IdentityFrom(r.Context())
	if caller.UserID == id {
		writeErr(w, http.StatusBadRequest, errors.New("cannot delete yourself"))
		return
	}
	u, err := s.store.GetUser(id)
	if err != nil {
		safeStoreErr(w, err)
		return
	}
	if err := s.store.DeleteUser(id); err != nil {
		safeStoreErr(w, err)
		return
	}
	s.audit(r, model.AuditUserDeleted, id, "user", map[string]interface{}{
		"username": u.Username,
	})
	w.WriteHeader(http.StatusNoContent)
}

// requireAdmin enforces the admin flag on the caller.
func requireAdmin(w http.ResponseWriter, r *http.Request) bool {
	id := auth.IdentityFrom(r.Context())
	if id.IsAdmin || (id.System && id.Role >= auth.RoleAdmin) {
		return true
	}
	writeErr(w, http.StatusForbidden, errors.New("admin required"))
	return false
}
