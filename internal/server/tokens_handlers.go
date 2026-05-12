package server

import (
	"errors"
	"net/http"

	"github.com/axgrid/discovery2/internal/auth"
)

// tokensResponse is what /v1/tokens returns. Levels below the caller's
// role come back as nil — JSON serialises that as `null` due to
// `omitempty`, so the UI never sees raw secrets for a tier the caller
// can't legitimately use anyway.
type tokensResponse struct {
	Read  []string `json:"read,omitempty"`
	Write []string `json:"write,omitempty"`
	Admin []string `json:"admin,omitempty"`
	// Role is included so the UI can render the right number of sections
	// without re-deriving from /v1/auth/me.
	Role string `json:"role"`
}

// listTokens returns the static service tokens the caller is allowed to
// see, gated by their resolved role:
//
//   - RoleRead  → only the read-token list
//   - RoleWrite → read + write
//   - RoleAdmin → all three
//
// Anonymous callers (including anonymous-read) get 401: there's no
// upside to handing tokens to unauthenticated visitors even if their
// effective level matches.
func (s *Server) listTokens(w http.ResponseWriter, r *http.Request) {
	id := auth.IdentityFrom(r.Context())
	if id.UserID == "" && !id.System {
		writeErr(w, http.StatusUnauthorized, errors.New("authentication required"))
		return
	}
	if id.Role < auth.RoleRead {
		writeErr(w, http.StatusForbidden, errors.New("read access required"))
		return
	}
	resp := tokensResponse{Role: id.Role.String()}
	resp.Read = s.auth.ReadTokens()
	if id.Role >= auth.RoleWrite {
		resp.Write = s.auth.WriteTokens()
	}
	if id.Role >= auth.RoleAdmin {
		resp.Admin = s.auth.AdminTokens()
	}
	writeJSON(w, http.StatusOK, resp)
}
