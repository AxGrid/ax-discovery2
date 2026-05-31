package server

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/google/uuid"

	"github.com/axgrid/discovery2/internal/auth"
	"github.com/axgrid/discovery2/internal/model"
)

// Client-token management. Visibility and mutation require write-or-admin (a
// read-only caller can't even list them). You cannot mint a token with a role
// higher than your own, so a write user can't escalate to admin.

func (s *Server) routesClientTokens(api *http.ServeMux) {
	api.HandleFunc("GET /v1/client-tokens", s.listClientTokens)
	api.HandleFunc("POST /v1/client-tokens", s.createClientToken)
	api.HandleFunc("DELETE /v1/client-tokens/{id}", s.revokeClientToken)
}

func (s *Server) listClientTokens(w http.ResponseWriter, r *http.Request) {
	if !requireWrite(w, r) {
		return
	}
	toks, err := s.store.ListClientTokens()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	if toks == nil {
		toks = []model.ClientToken{}
	}
	writeJSON(w, http.StatusOK, toks)
}

type createTokenInput struct {
	Name string `json:"name"`
	Role string `json:"role"`
}

func (s *Server) createClientToken(w http.ResponseWriter, r *http.Request) {
	if !requireWrite(w, r) {
		return
	}
	var in createTokenInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	in.Name = strings.TrimSpace(in.Name)
	if in.Name == "" {
		writeErr(w, http.StatusBadRequest, errors.New("token name required"))
		return
	}
	role := auth.RoleFromString(in.Role)
	if role == auth.RoleNone {
		writeErr(w, http.StatusBadRequest, errors.New("role must be read, write, or admin"))
		return
	}
	// No privilege escalation: can't mint a token above your own role.
	if role > auth.IdentityFrom(r.Context()).Role {
		writeErr(w, http.StatusForbidden, errors.New("cannot create a token with a role higher than your own"))
		return
	}
	secret, err := generateToken()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	tok := &model.ClientToken{
		ID:        uuid.NewString(),
		Token:     secret,
		Name:      in.Name,
		Role:      role.String(),
		CreatedBy: auth.IdentityFrom(r.Context()).ActorName(),
	}
	if err := s.store.PutClientToken(tok); err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	s.audit(r, model.AuditTokenCreated, tok.ID, "token", map[string]interface{}{
		"name": tok.Name, "role": tok.Role,
	})
	writeJSON(w, http.StatusCreated, tok)
}

func (s *Server) revokeClientToken(w http.ResponseWriter, r *http.Request) {
	if !requireWrite(w, r) {
		return
	}
	id := r.PathValue("id")
	tok, err := s.store.DeleteClientTokenByID(id)
	if err != nil {
		safeStoreErr(w, err)
		return
	}
	s.audit(r, model.AuditTokenRevoked, tok.ID, "token", map[string]interface{}{"name": tok.Name})
	w.WriteHeader(http.StatusNoContent)
}

// generateToken returns a URL-safe random bearer secret with a "dsc_" prefix.
func generateToken() (string, error) {
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return "dsc_" + base64.RawURLEncoding.EncodeToString(b), nil
}
