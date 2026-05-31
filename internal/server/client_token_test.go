package server

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/axgrid/discovery2/internal/model"
)

func TestClientTokenLifecycle(t *testing.T) {
	srv, _ := newTestServerTokens(t, "w", "adm")

	// read-only / anonymous caller cannot even list tokens.
	if code, _ := doJSON(t, http.MethodGet, srv.URL+"/v1/client-tokens", "", nil); code != http.StatusForbidden {
		t.Fatalf("anonymous list: want 403, got %d", code)
	}

	// admin creates a write-role token.
	code, body := doJSON(t, http.MethodPost, srv.URL+"/v1/client-tokens", "adm",
		map[string]any{"name": "ci-runner", "role": "write"})
	if code != http.StatusCreated {
		t.Fatalf("create: want 201, got %d (%s)", code, body)
	}
	var tok model.ClientToken
	json.Unmarshal(body, &tok)
	if !strings.HasPrefix(tok.Token, "dsc_") || tok.Role != "write" {
		t.Fatalf("unexpected token: %+v", tok)
	}

	// the minted token authenticates a write operation.
	wreq, _ := http.NewRequest(http.MethodPut, srv.URL+"/v1/services/billing",
		strings.NewReader(`{"description":"via dynamic token"}`))
	wreq.Header.Set("Authorization", "Bearer "+tok.Token)
	wreq.Header.Set("Content-Type", "application/json")
	wresp, _ := http.DefaultClient.Do(wreq)
	if wresp.StatusCode != http.StatusOK {
		t.Fatalf("write with minted token: want 200, got %d", wresp.StatusCode)
	}
	wresp.Body.Close()

	// it shows up in the list.
	_, body = doJSON(t, http.MethodGet, srv.URL+"/v1/client-tokens", "adm", nil)
	var list []model.ClientToken
	json.Unmarshal(body, &list)
	if len(list) != 1 || list[0].ID != tok.ID {
		t.Fatalf("list mismatch: %+v", list)
	}

	// revoke it.
	if code, _ := doJSON(t, http.MethodDelete, srv.URL+"/v1/client-tokens/"+tok.ID, "adm", nil); code != http.StatusNoContent {
		t.Fatalf("revoke: want 204, got %d", code)
	}
	// the revoked token no longer authenticates.
	rreq, _ := http.NewRequest(http.MethodPut, srv.URL+"/v1/services/x", strings.NewReader(`{}`))
	rreq.Header.Set("Authorization", "Bearer "+tok.Token)
	rresp, _ := http.DefaultClient.Do(rreq)
	if rresp.StatusCode == http.StatusOK {
		t.Fatal("revoked token still works")
	}
	rresp.Body.Close()
}

func TestClientTokenNoEscalation(t *testing.T) {
	srv, _ := newTestServerTokens(t, "w", "adm")
	// a write-role caller cannot mint an admin token.
	if code, _ := doJSON(t, http.MethodPost, srv.URL+"/v1/client-tokens", "w",
		map[string]any{"name": "evil", "role": "admin"}); code != http.StatusForbidden {
		t.Fatalf("write→admin escalation: want 403, got %d", code)
	}
	// but it can mint a read token.
	if code, _ := doJSON(t, http.MethodPost, srv.URL+"/v1/client-tokens", "w",
		map[string]any{"name": "reader", "role": "read"}); code != http.StatusCreated {
		t.Fatalf("write→read: want 201, got %d", code)
	}
}
