package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/axgrid/discovery2/internal/auth"
	"github.com/axgrid/discovery2/internal/model"
	"github.com/axgrid/discovery2/internal/store"
)

// newTestServerTokens is like newTestServer but lets a test set write/admin tokens.
func newTestServerTokens(t *testing.T, write, admin string) (*httptest.Server, *store.Store) {
	t.Helper()
	dir := t.TempDir()
	st, err := store.Open(filepath.Join(dir, "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	a := auth.New(auth.Config{AllowAnonymousRead: true, WriteTokens: []string{write}, AdminTokens: []string{admin}})
	s := New(Config{}, st, a, nil, nil)
	mux := http.NewServeMux()
	s.routes(mux)
	t.Cleanup(func() { st.Close() })
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	go s.hub.Run(make(chan struct{}))
	return srv, st
}

func sv(s string) model.TypedValue {
	b, _ := json.Marshal(s)
	return model.TypedValue{Type: model.VarString, Value: b}
}
func iv(n int) model.TypedValue {
	b, _ := json.Marshal(n)
	return model.TypedValue{Type: model.VarInt, Value: b}
}

func doJSON(t *testing.T, method, url, token string, body any) (int, []byte) {
	t.Helper()
	var rdr *bytes.Reader
	if body != nil {
		buf, _ := json.Marshal(body)
		rdr = bytes.NewReader(buf)
	} else {
		rdr = bytes.NewReader(nil)
	}
	req, _ := http.NewRequest(method, url, rdr)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	out := new(bytes.Buffer)
	_, _ = out.ReadFrom(resp.Body)
	return resp.StatusCode, out.Bytes()
}

func TestConfigApplyResolveMerge(t *testing.T) {
	srv, _ := newTestServerTokens(t, "w", "adm")
	apply := func(scope model.ConfigScope, vars map[string]model.TypedValue, token string) int {
		code, _ := doJSON(t, http.MethodPost, srv.URL+"/v1/config/apply", token,
			map[string]any{"scope": scope, "vars": vars})
		return code
	}

	// global requires admin
	if code := apply(model.ConfigScope{Kind: "global"}, map[string]model.TypedValue{"shared": sv("g"), "a": iv(1)}, "w"); code != http.StatusForbidden {
		t.Fatalf("global apply with write token: want 403, got %d", code)
	}
	if code := apply(model.ConfigScope{Kind: "global"}, map[string]model.TypedValue{"shared": sv("g"), "a": iv(1)}, "adm"); code != http.StatusOK {
		t.Fatalf("global apply with admin: want 200, got %d", code)
	}
	// service + two version blocks (write token ok — service doesn't exist yet)
	apply(model.ConfigScope{Kind: "service", Service: "billing"}, map[string]model.TypedValue{"shared": sv("s"), "b": iv(2)}, "w")
	apply(model.ConfigScope{Kind: "version", Service: "billing", Constraint: ">=2.0.0"}, map[string]model.TypedValue{"shared": sv("v2")}, "w")
	apply(model.ConfigScope{Kind: "version", Service: "billing", Constraint: ">=2.1.0"}, map[string]model.TypedValue{"shared": sv("v21")}, "w")

	resolve := func(version string) model.ResolvedConfig {
		code, body := doJSON(t, http.MethodGet, srv.URL+"/v1/config/resolve?service=billing&version="+version, "", nil)
		if code != http.StatusOK {
			t.Fatalf("resolve %s: status %d", version, code)
		}
		var rc model.ResolvedConfig
		if err := json.Unmarshal(body, &rc); err != nil {
			t.Fatal(err)
		}
		return rc
	}

	// 2.1.0: global<service<version, and >=2.1.0 (higher floor) beats >=2.0.0.
	rc := resolve("2.1.0")
	if got := string(rc.Vars["shared"].Value); got != `"v21"` {
		t.Errorf("shared@2.1.0 = %s, want \"v21\"", got)
	}
	if string(rc.Vars["a"].Value) != "1" || string(rc.Vars["b"].Value) != "2" {
		t.Errorf("merged a/b wrong: %v", rc.Vars)
	}
	// 2.0.0: only >=2.0.0 matches.
	if got := string(resolve("2.0.0").Vars["shared"].Value); got != `"v2"` {
		t.Errorf("shared@2.0.0 = %s, want \"v2\"", got)
	}
	// 1.0.0: no version block matches → service value wins.
	if got := string(resolve("1.0.0").Vars["shared"].Value); got != `"s"` {
		t.Errorf("shared@1.0.0 = %s, want \"s\"", got)
	}
}

func TestConfigTypeValidation(t *testing.T) {
	srv, _ := newTestServerTokens(t, "w", "adm")
	// int var with a non-integer value must be rejected.
	bad := model.TypedValue{Type: model.VarInt, Value: json.RawMessage(`"oops"`)}
	code, _ := doJSON(t, http.MethodPost, srv.URL+"/v1/config/apply", "w",
		map[string]any{"scope": model.ConfigScope{Kind: "service", Service: "x"}, "vars": map[string]model.TypedValue{"n": bad}})
	if code != http.StatusBadRequest {
		t.Fatalf("bad int: want 400, got %d", code)
	}
}

func TestConfigRevisionHistoryRollback(t *testing.T) {
	srv, _ := newTestServerTokens(t, "w", "adm")
	scope := model.ConfigScope{Kind: "service", Service: "billing"}
	apply := func(vars map[string]model.TypedValue) {
		doJSON(t, http.MethodPost, srv.URL+"/v1/config/apply", "w", map[string]any{"scope": scope, "vars": vars})
	}
	apply(map[string]model.TypedValue{"k": sv("one")})   // rev 1
	apply(map[string]model.TypedValue{"k": sv("two")})   // rev 2
	apply(map[string]model.TypedValue{"k": sv("three")}) // rev 3

	// rollback to rev 1 → creates rev 4 with rev1 content
	code, body := doJSON(t, http.MethodPost, srv.URL+"/v1/config/rollback", "w",
		map[string]any{"scope": scope, "revision": 1})
	if code != http.StatusOK {
		t.Fatalf("rollback status %d", code)
	}
	var rev model.ConfigRevision
	json.Unmarshal(body, &rev)
	if rev.Revision != 4 {
		t.Errorf("rollback new revision = %d, want 4", rev.Revision)
	}
	if string(rev.Vars["k"].Value) != `"one"` {
		t.Errorf("rolled-back value = %s, want \"one\"", string(rev.Vars["k"].Value))
	}

	// history has 4 revisions
	code, body = doJSON(t, http.MethodGet, srv.URL+"/v1/config/scope?kind=service&service=billing&include=history", "", nil)
	if code != http.StatusOK {
		t.Fatalf("get scope status %d", code)
	}
	var resp configScopeResponse
	json.Unmarshal(body, &resp)
	if len(resp.History) != 4 {
		t.Errorf("history len = %d, want 4", len(resp.History))
	}
	if resp.Active == nil || string(resp.Active.Vars["k"].Value) != `"one"` {
		t.Errorf("active after rollback wrong: %+v", resp.Active)
	}
}

func TestConfigPrefixFilter(t *testing.T) {
	srv, _ := newTestServerTokens(t, "w", "adm")
	doJSON(t, http.MethodPost, srv.URL+"/v1/config/apply", "w", map[string]any{
		"scope": model.ConfigScope{Kind: "service", Service: "billing"},
		"vars": map[string]model.TypedValue{
			"db/host": sv("h"), "db/port": iv(5432), "feature/x": sv("on"),
		},
	})
	code, body := doJSON(t, http.MethodGet, srv.URL+"/v1/config/resolve?service=billing&prefix=db/", "", nil)
	if code != http.StatusOK {
		t.Fatalf("resolve status %d", code)
	}
	var rc model.ResolvedConfig
	json.Unmarshal(body, &rc)
	if len(rc.Vars) != 2 || rc.Vars["feature/x"].Value != nil {
		t.Errorf("prefix filter wrong: %v", rc.Vars)
	}
}
