package server

import (
	"io"
	"net/http"
	"testing"

	"github.com/axgrid/discovery2/internal/model"
)

func doReq(t *testing.T, method, url, ifNoneMatch string) (int, string, []byte) {
	t.Helper()
	req, _ := http.NewRequest(method, url, nil)
	if ifNoneMatch != "" {
		req.Header.Set("If-None-Match", ifNoneMatch)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, resp.Header.Get("ETag"), b
}

func TestConfigResolveETag(t *testing.T) {
	srv, _ := newTestServerTokens(t, "w", "adm")
	apply := func(vars map[string]model.TypedValue) {
		doJSON(t, http.MethodPost, srv.URL+"/v1/config/apply", "w",
			map[string]any{"scope": model.ConfigScope{Kind: "service", Service: "billing"}, "vars": vars})
	}
	apply(map[string]model.TypedValue{"db/host": sv("h"), "db/port": iv(5432), "feature/x": sv("on")})

	url := srv.URL + "/v1/config/resolve?service=billing"
	code, etag, _ := doReq(t, http.MethodGet, url, "")
	if code != http.StatusOK || etag == "" {
		t.Fatalf("GET status=%d etag=%q", code, etag)
	}
	// Conditional GET with the current etag → 304, no body.
	if code, _, body := doReq(t, http.MethodGet, url, etag); code != http.StatusNotModified || len(body) != 0 {
		t.Fatalf("conditional GET: want 304+empty, got %d body=%d", code, len(body))
	}
	// HEAD → same etag, no body.
	if code, e, body := doReq(t, http.MethodHead, url, ""); code != http.StatusOK || e != etag || len(body) != 0 {
		t.Fatalf("HEAD: want 200 etag=%q empty, got %d etag=%q body=%d", etag, code, e, len(body))
	}

	// Prefix-scoped etag ("именно на мой запрос"): editing a var OUTSIDE the
	// prefix must NOT change it; editing one INSIDE must.
	purl := srv.URL + "/v1/config/resolve?service=billing&prefix=db/"
	_, petag, _ := doReq(t, http.MethodGet, purl, "")
	apply(map[string]model.TypedValue{"db/host": sv("h"), "db/port": iv(5432), "feature/x": sv("OFF")}) // out-of-prefix
	if _, p2, _ := doReq(t, http.MethodGet, purl, ""); p2 != petag {
		t.Errorf("prefix etag changed on out-of-prefix edit: %q -> %q", petag, p2)
	}
	apply(map[string]model.TypedValue{"db/host": sv("h2"), "db/port": iv(5432), "feature/x": sv("OFF")}) // in-prefix
	if _, p3, _ := doReq(t, http.MethodGet, purl, ""); p3 == petag {
		t.Error("prefix etag should change on in-prefix edit")
	}
}

func TestDiscoverETag(t *testing.T) {
	srv, _ := newTestServer(t)
	register(t, srv.URL, "api", "a", "10.0.0.1", "2.1.0")

	url := srv.URL + "/v1/discover/api"
	code, etag, _ := doReq(t, http.MethodGet, url, "")
	if code != http.StatusOK || etag == "" {
		t.Fatalf("GET status=%d etag=%q", code, etag)
	}
	if code, _, _ := doReq(t, http.MethodGet, url, etag); code != http.StatusNotModified {
		t.Fatalf("conditional GET: want 304, got %d", code)
	}
	if code, e, body := doReq(t, http.MethodHead, url, ""); code != http.StatusOK || e != etag || len(body) != 0 {
		t.Fatalf("HEAD: want 200 etag=%q empty, got %d etag=%q body=%d", etag, code, e, len(body))
	}
	// Adding an instance changes the pool → etag changes.
	register(t, srv.URL, "api", "b", "10.0.0.2", "2.1.0")
	if _, e2, _ := doReq(t, http.MethodGet, url, ""); e2 == etag {
		t.Error("discover etag should change after adding an instance")
	}
}
