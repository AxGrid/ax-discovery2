package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/axgrid/discovery2/internal/auth"
	"github.com/axgrid/discovery2/internal/model"
	"github.com/axgrid/discovery2/internal/semver"
	"github.com/axgrid/discovery2/internal/store"
)

// Config endpoints. Scopes are passed in request bodies (not paths) because a
// version scope's constraint (">=2.1.0") doesn't path-encode cleanly. Reads use
// query params. Writes are block-atomic: Apply replaces a scope's whole var set
// with a new revision. ACL: global → admin; service/version → service ACL (or
// any write-role when the service doesn't exist yet, so config can be
// pre-provisioned before the service registers).

func (s *Server) routesConfig(api *http.ServeMux) {
	api.HandleFunc("GET /v1/config/resolve", s.configResolve)
	api.HandleFunc("GET /v1/config/scopes", s.configScopes)
	api.HandleFunc("GET /v1/config/scope", s.configGetScope)
	api.HandleFunc("POST /v1/config/apply", s.configApply)
	api.HandleFunc("POST /v1/config/draft", s.configSaveDraft)
	api.HandleFunc("DELETE /v1/config/draft", s.configDeleteDraft)
	api.HandleFunc("POST /v1/config/rollback", s.configRollback)
	api.HandleFunc("DELETE /v1/config/scope", s.configDeleteScope)
}

// --- reads ---

func (s *Server) configResolve(w http.ResponseWriter, r *http.Request) {
	if !requireRead(w, r) {
		return
	}
	q := r.URL.Query()
	service := strings.TrimSpace(q.Get("service"))
	version := strings.TrimSpace(q.Get("version"))
	res, err := s.store.ResolveConfig(service, version, q["prefix"], q["key"])
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

func (s *Server) configScopes(w http.ResponseWriter, r *http.Request) {
	if !requireRead(w, r) {
		return
	}
	scopes, err := s.store.ListConfigScopes()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	if scopes == nil {
		scopes = []store.ConfigScopeSummary{}
	}
	writeJSON(w, http.StatusOK, scopes)
}

type configScopeResponse struct {
	Scope   model.ConfigScope      `json:"scope"`
	Active  *model.ConfigRevision  `json:"active,omitempty"`
	Draft   *model.ConfigDraft     `json:"draft,omitempty"`
	History []model.ConfigRevision `json:"history,omitempty"`
}

func (s *Server) configGetScope(w http.ResponseWriter, r *http.Request) {
	if !requireRead(w, r) {
		return
	}
	scope, ok := scopeFromQuery(w, r)
	if !ok {
		return
	}
	resp := configScopeResponse{Scope: scope}
	if active, err := s.store.GetActiveConfig(scope); err == nil {
		resp.Active = active
	} else if !errors.Is(err, store.ErrNotFound) {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	include := r.URL.Query().Get("include")
	if strings.Contains(include, "draft") {
		if d, err := s.store.GetDraft(scope); err == nil {
			resp.Draft = d
		}
	}
	if strings.Contains(include, "history") {
		if h, err := s.store.ConfigHistory(scope); err == nil {
			resp.History = h
		}
	}
	writeJSON(w, http.StatusOK, resp)
}

// --- writes ---

type configApplyInput struct {
	Scope model.ConfigScope           `json:"scope"`
	Vars  map[string]model.TypedValue `json:"vars"`
	Note  string                      `json:"note,omitempty"`
}

func (s *Server) configApply(w http.ResponseWriter, r *http.Request) {
	var in configApplyInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	if !s.prepareScopeWrite(w, r, &in.Scope) {
		return
	}
	if err := validateConfigVars(in.Vars); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	rev, err := s.store.ApplyConfig(in.Scope, in.Vars, in.Note, auth.IdentityFrom(r.Context()).ActorName())
	if err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	s.audit(r, model.AuditConfigApplied, in.Scope.ID(), "config", map[string]interface{}{
		"revision": rev.Revision, "vars": len(rev.Vars),
	})
	writeJSON(w, http.StatusOK, rev)
}

type configDraftInput struct {
	Scope model.ConfigScope           `json:"scope"`
	Vars  map[string]model.TypedValue `json:"vars"`
}

func (s *Server) configSaveDraft(w http.ResponseWriter, r *http.Request) {
	var in configDraftInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	if !s.prepareScopeWrite(w, r, &in.Scope) {
		return
	}
	if err := validateConfigVars(in.Vars); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	d, err := s.store.PutDraft(in.Scope, in.Vars, auth.IdentityFrom(r.Context()).ActorName())
	if err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	s.audit(r, model.AuditConfigDraftSaved, in.Scope.ID(), "config", nil)
	writeJSON(w, http.StatusOK, d)
}

type configScopeOnlyInput struct {
	Scope model.ConfigScope `json:"scope"`
}

func (s *Server) configDeleteDraft(w http.ResponseWriter, r *http.Request) {
	var in configScopeOnlyInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	if !s.prepareScopeWrite(w, r, &in.Scope) {
		return
	}
	if err := s.store.DeleteDraft(in.Scope); err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	s.audit(r, model.AuditConfigDraftDiscarded, in.Scope.ID(), "config", nil)
	w.WriteHeader(http.StatusNoContent)
}

type configRollbackInput struct {
	Scope    model.ConfigScope `json:"scope"`
	Revision int               `json:"revision"`
}

func (s *Server) configRollback(w http.ResponseWriter, r *http.Request) {
	var in configRollbackInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	if !s.prepareScopeWrite(w, r, &in.Scope) {
		return
	}
	rev, err := s.store.RollbackConfig(in.Scope, in.Revision, auth.IdentityFrom(r.Context()).ActorName())
	if err != nil {
		safeStoreErr(w, err)
		return
	}
	s.audit(r, model.AuditConfigRolledBack, in.Scope.ID(), "config", map[string]interface{}{
		"from": in.Revision, "newRevision": rev.Revision,
	})
	writeJSON(w, http.StatusOK, rev)
}

func (s *Server) configDeleteScope(w http.ResponseWriter, r *http.Request) {
	var in configScopeOnlyInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	if !s.prepareScopeWrite(w, r, &in.Scope) {
		return
	}
	if err := s.store.DeleteConfigScope(in.Scope); err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	s.audit(r, model.AuditConfigDeleted, in.Scope.ID(), "config", nil)
	w.WriteHeader(http.StatusNoContent)
}

// --- helpers ---

// prepareScopeWrite validates the scope and enforces the write ACL. It writes
// the error response and returns false on failure.
func (s *Server) prepareScopeWrite(w http.ResponseWriter, r *http.Request, scope *model.ConfigScope) bool {
	if err := scope.Validate(); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return false
	}
	if scope.Kind == model.ScopeVersion && !semver.ValidConstraint(scope.Constraint) {
		writeErr(w, http.StatusBadRequest, fmt.Errorf("invalid version constraint %q", scope.Constraint))
		return false
	}
	return s.allowConfigWrite(w, r, *scope)
}

// allowConfigWrite enforces: global → admin; service/version → service ACL,
// falling back to any write-role when the service doesn't exist yet.
func (s *Server) allowConfigWrite(w http.ResponseWriter, r *http.Request, scope model.ConfigScope) bool {
	if scope.Kind == model.ScopeGlobal {
		return requireAdmin(w, r)
	}
	if !requireWrite(w, r) {
		return false
	}
	svc, err := s.store.GetService(scope.Service)
	if errors.Is(err, store.ErrNotFound) {
		return true // pre-provisioning config before the service exists
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return false
	}
	if !auth.CanEditService(svc, auth.IdentityFrom(r.Context())) {
		writeErr(w, http.StatusForbidden, errors.New("not allowed to edit this service's config"))
		return false
	}
	return true
}

func scopeFromQuery(w http.ResponseWriter, r *http.Request) (model.ConfigScope, bool) {
	q := r.URL.Query()
	scope := model.ConfigScope{
		Kind:       strings.TrimSpace(q.Get("kind")),
		Service:    strings.TrimSpace(q.Get("service")),
		Constraint: strings.TrimSpace(q.Get("constraint")),
	}
	if err := scope.Validate(); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return scope, false
	}
	return scope, true
}

func validateConfigVars(vars map[string]model.TypedValue) error {
	for k, v := range vars {
		if strings.TrimSpace(k) == "" {
			return errors.New("config key must not be empty")
		}
		if err := v.Validate(); err != nil {
			return fmt.Errorf("%s: %w", k, err)
		}
	}
	return nil
}
