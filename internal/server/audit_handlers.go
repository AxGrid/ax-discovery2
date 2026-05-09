package server

import (
	"net/http"
	"strconv"

	"github.com/axgrid/discovery2/internal/model"
)

func (s *Server) listAudit(w http.ResponseWriter, r *http.Request) {
	if !requireAdmin(w, r) {
		return
	}
	limit := 200
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			limit = n
		}
	}
	service := r.URL.Query().Get("service")
	entries, err := s.store.ListAudit(limit, service)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	if entries == nil {
		entries = []model.AuditEntry{}
	}
	writeJSON(w, http.StatusOK, entries)
}
