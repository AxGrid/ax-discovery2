package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/axgrid/discovery2/internal/auth"
	"github.com/axgrid/discovery2/internal/model"
	"github.com/axgrid/discovery2/internal/store"
)

func newTestServer(t *testing.T) (*httptest.Server, *store.Store) {
	t.Helper()
	dir := t.TempDir()
	st, err := store.Open(filepath.Join(dir, "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	a := auth.New(auth.Config{
		AllowAnonymousRead: true,
		WriteTokens:        []string{"w"},
	})
	s := New(Config{}, st, a, nil, nil)
	mux := http.NewServeMux()
	s.routes(mux)
	t.Cleanup(func() { st.Close() })
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	go s.hub.Run(make(chan struct{}))
	_ = context.Background()
	return srv, st
}

func TestRegisterAndDiscover(t *testing.T) {
	srv, _ := newTestServer(t)

	body := `{"id":"i1","address":"10.0.0.5","interfaces":[{"name":"WEB","protocol":"http","port":8080}],"ttlSeconds":30}`
	req, _ := http.NewRequest(http.MethodPut, srv.URL+"/v1/services/billing/instances/i1",
		strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer w")
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != 200 {
		t.Fatalf("register status %d", resp.StatusCode)
	}
	resp.Body.Close()

	resp, err = http.Get(srv.URL + "/v1/discover/billing")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var insts []model.Instance
	if err := json.NewDecoder(resp.Body).Decode(&insts); err != nil {
		t.Fatal(err)
	}
	if len(insts) != 1 || insts[0].Address != "10.0.0.5" {
		t.Fatalf("want one instance with addr, got %+v", insts)
	}
}

func TestWriteRequiresToken(t *testing.T) {
	srv, _ := newTestServer(t)
	req, _ := http.NewRequest(http.MethodPut, srv.URL+"/v1/services/x", strings.NewReader("{}"))
	resp, _ := http.DefaultClient.Do(req)
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("expected 403, got %d", resp.StatusCode)
	}
}

func TestHealth(t *testing.T) {
	srv, _ := newTestServer(t)
	resp, err := http.Get(srv.URL + "/v1/health")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("health status %d", resp.StatusCode)
	}
}
