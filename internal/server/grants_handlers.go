package server

import (
	"encoding/json"
	"errors"
	"net/http"
	"slices"

	"github.com/axgrid/discovery2/internal/auth"
	"github.com/axgrid/discovery2/internal/model"
)

type grantRequest struct {
	UserID string `json:"userId"`
}

// addGrant grants edit permission to userId on a private service.
// Only the service owner or an admin may add grants.
func (s *Server) addGrant(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	svc, err := s.store.GetService(name)
	if err != nil {
		safeStoreErr(w, err)
		return
	}
	id := auth.IdentityFrom(r.Context())
	if !canManageGrants(svc, id) {
		writeErr(w, http.StatusForbidden, errors.New("only owner or admin can manage grants"))
		return
	}
	var req grantRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	if req.UserID == "" {
		writeErr(w, http.StatusBadRequest, errors.New("userId required"))
		return
	}
	// The userId is a corp-ui user id (stringified uint). We don't validate
	// against corp here — if the operator misspells it the grant simply
	// never matches at CanEditService check time, which is harmless.
	if !slices.Contains(svc.Grants, req.UserID) {
		svc.Grants = append(svc.Grants, req.UserID)
		if err := s.store.PutService(svc); err != nil {
			safeStoreErr(w, err)
			return
		}
		s.audit(r, model.AuditGrantAdded, name, "service", map[string]interface{}{
			"userId": req.UserID,
		})
	}
	writeJSON(w, http.StatusOK, svc)
}

func (s *Server) removeGrant(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	userID := r.PathValue("userId")
	svc, err := s.store.GetService(name)
	if err != nil {
		safeStoreErr(w, err)
		return
	}
	id := auth.IdentityFrom(r.Context())
	if !canManageGrants(svc, id) {
		writeErr(w, http.StatusForbidden, errors.New("only owner or admin can manage grants"))
		return
	}
	old := svc.Grants
	svc.Grants = slices.DeleteFunc(svc.Grants, func(g string) bool { return g == userID })
	if len(svc.Grants) != len(old) {
		if err := s.store.PutService(svc); err != nil {
			safeStoreErr(w, err)
			return
		}
		s.audit(r, model.AuditGrantRemoved, name, "service", map[string]interface{}{
			"userId": userID,
		})
	}
	w.WriteHeader(http.StatusNoContent)
}

// canManageGrants is stricter than CanEdit: only owner or admin may grant.
func canManageGrants(svc *model.Service, id auth.Identity) bool {
	if id.IsAdmin || (id.System && id.Role >= auth.RoleAdmin) {
		return true
	}
	return svc.OwnerID != "" && svc.OwnerID == id.UserID
}
