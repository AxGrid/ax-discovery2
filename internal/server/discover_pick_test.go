package server

import (
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"testing"

	"github.com/axgrid/discovery2/internal/model"
)

// register puts an instance with the given id/address/version via the write token.
func register(t *testing.T, srv string, service, id, address, version string) {
	t.Helper()
	body := map[string]any{
		"id":      id,
		"address": address,
		"version": version,
		"interfaces": []map[string]any{
			{"name": "WEB", "protocol": "http", "port": 8080},
		},
		"ttlSeconds": 30,
	}
	buf, _ := json.Marshal(body)
	req, _ := http.NewRequest(http.MethodPut, srv+"/v1/services/"+service+"/instances/"+id, strings.NewReader(string(buf)))
	req.Header.Set("Authorization", "Bearer w")
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("register %s/%s status %d", service, id, resp.StatusCode)
	}
	resp.Body.Close()
}

func getJSON(t *testing.T, u string, out any) int {
	t.Helper()
	resp, err := http.Get(u)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if out != nil && resp.StatusCode == http.StatusOK {
		if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
			t.Fatal(err)
		}
	}
	return resp.StatusCode
}

func TestDiscoverVersionConstraint(t *testing.T) {
	srv, _ := newTestServer(t)
	register(t, srv.URL, "api", "v1", "10.0.0.1", "1.9.0")
	register(t, srv.URL, "api", "v2", "10.0.0.2", "2.1.0")
	register(t, srv.URL, "api", "v3", "10.0.0.3", "2.4.0")
	register(t, srv.URL, "api", "nover", "10.0.0.9", "") // no version

	var insts []model.Instance
	code := getJSON(t, srv.URL+"/v1/discover/api?version="+url.QueryEscape(">=2.1.0"), &insts)
	if code != http.StatusOK {
		t.Fatalf("status %d", code)
	}
	got := map[string]bool{}
	for _, i := range insts {
		got[i.ID] = true
	}
	if !got["v2"] || !got["v3"] {
		t.Errorf("want v2,v3 in result, got %v", got)
	}
	if got["v1"] {
		t.Error("v1 (1.9.0) should be excluded by >=2.1.0")
	}
	if got["nover"] {
		t.Error("unversioned instance should be excluded when a constraint is set")
	}
}

func TestDiscoverBadConstraint(t *testing.T) {
	srv, _ := newTestServer(t)
	register(t, srv.URL, "api", "v1", "10.0.0.1", "1.0.0")
	code := getJSON(t, srv.URL+"/v1/discover/api?version="+url.QueryEscape("@@@bad"), nil)
	if code != http.StatusBadRequest {
		t.Fatalf("want 400 for bad constraint, got %d", code)
	}
}

func TestDiscoverFormatAddr(t *testing.T) {
	srv, _ := newTestServer(t)
	register(t, srv.URL, "api", "v1", "10.0.0.1", "2.1.0")

	var addrs []string
	code := getJSON(t, srv.URL+"/v1/discover/api?format=addr&iface=WEB", &addrs)
	if code != http.StatusOK {
		t.Fatalf("status %d", code)
	}
	if len(addrs) != 1 || addrs[0] != "10.0.0.1:8080" {
		t.Fatalf("want [10.0.0.1:8080], got %v", addrs)
	}
}

func TestPickWeighted(t *testing.T) {
	srv, _ := newTestServer(t)
	register(t, srv.URL, "api", "v1", "10.0.0.1", "2.1.0")

	var res PickResult
	code := getJSON(t, srv.URL+"/v1/discover/api/pick?iface=WEB", &res)
	if code != http.StatusOK {
		t.Fatalf("status %d", code)
	}
	if res.Address != "10.0.0.1:8080" {
		t.Fatalf("want address 10.0.0.1:8080, got %q", res.Address)
	}
	if res.URL != "http://10.0.0.1:8080" {
		t.Fatalf("want url http://10.0.0.1:8080, got %q", res.URL)
	}
}

func TestPickNoHealthy(t *testing.T) {
	srv, _ := newTestServer(t)
	code := getJSON(t, srv.URL+"/v1/discover/missing/pick", nil)
	if code != http.StatusServiceUnavailable {
		t.Fatalf("want 503, got %d", code)
	}
}

func TestPickStickyToken(t *testing.T) {
	srv, st := newTestServer(t)
	register(t, srv.URL, "api", "a", "10.0.0.1", "2.1.0")
	register(t, srv.URL, "api", "b", "10.0.0.2", "2.1.0")
	register(t, srv.URL, "api", "c", "10.0.0.3", "2.1.0")

	// First pick binds the token; subsequent picks must return the same instance.
	var first PickResult
	getJSON(t, srv.URL+"/v1/discover/api/pick?token=sess-123", &first)
	if first.Instance == nil || !first.Sticky {
		t.Fatalf("expected sticky pick, got %+v", first)
	}
	pinned := first.Instance.ID
	for range 20 {
		var p PickResult
		getJSON(t, srv.URL+"/v1/discover/api/pick?token=sess-123", &p)
		if p.Instance == nil || p.Instance.ID != pinned {
			t.Fatalf("sticky token drifted: want %s got %+v", pinned, p.Instance)
		}
	}

	// The binding is persisted.
	if _, err := st.GetAffinity("api", "sess-123"); err != nil {
		t.Fatalf("affinity not persisted: %v", err)
	}

	// When the pinned instance goes DOWN, the next pick re-binds to a live one.
	if _, err := st.SetStatus("api", pinned, model.StatusDown); err != nil {
		t.Fatal(err)
	}
	var rb PickResult
	getJSON(t, srv.URL+"/v1/discover/api/pick?token=sess-123", &rb)
	if rb.Instance == nil {
		t.Fatal("expected a re-bound instance")
	}
	if rb.Instance.ID == pinned {
		t.Fatal("expected re-pin away from the DOWN instance")
	}
	if !rb.Rebound {
		t.Error("expected rebound=true after the pinned instance went down")
	}
}
