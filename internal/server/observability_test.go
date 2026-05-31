package server

import (
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/axgrid/discovery2/internal/model"
	"github.com/axgrid/discovery2/internal/stats"
)

func blockInst(t *testing.T, srv, service, id string, blocked bool) {
	t.Helper()
	body := `{"blocked":` + map[bool]string{true: "true", false: "false"}[blocked] + `}`
	req, _ := http.NewRequest(http.MethodPost, srv+"/v1/services/"+service+"/instances/"+id+"/block", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer w")
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("block status %d", resp.StatusCode)
	}
	resp.Body.Close()
}

func TestBlockExcludesFromDiscover(t *testing.T) {
	srv, st := newTestServer(t)
	register(t, srv.URL, "api", "a", "10.0.0.1", "2.1.0")
	register(t, srv.URL, "api", "b", "10.0.0.2", "2.1.0")

	blockInst(t, srv.URL, "api", "a", true)

	var insts []model.Instance
	getJSON(t, srv.URL+"/v1/discover/api", &insts)
	if len(insts) != 1 || insts[0].ID != "b" {
		t.Fatalf("blocked instance still discoverable: %+v", insts)
	}

	// The flag is persisted on the stored instance.
	got, err := st.GetInstance("api", "a")
	if err != nil || !got.Blocked {
		t.Fatalf("instance a should be blocked, got %+v err %v", got, err)
	}

	// Re-registering must NOT clear the operator block.
	register(t, srv.URL, "api", "a", "10.0.0.1", "2.2.0")
	got, _ = st.GetInstance("api", "a")
	if !got.Blocked {
		t.Fatal("re-register cleared the operator block")
	}

	// Unblock restores discoverability.
	blockInst(t, srv.URL, "api", "a", false)
	getJSON(t, srv.URL+"/v1/discover/api", &insts)
	if len(insts) != 2 {
		t.Fatalf("want 2 after unblock, got %d", len(insts))
	}
}

func TestBlockReboundsStickyToken(t *testing.T) {
	srv, _ := newTestServer(t)
	register(t, srv.URL, "api", "a", "10.0.0.1", "2.1.0")
	register(t, srv.URL, "api", "b", "10.0.0.2", "2.1.0")

	var first PickResult
	getJSON(t, srv.URL+"/v1/discover/api/pick?token=t1", &first)
	pinned := first.Instance.ID

	blockInst(t, srv.URL, "api", pinned, true)

	var rb PickResult
	getJSON(t, srv.URL+"/v1/discover/api/pick?token=t1", &rb)
	if rb.Instance.ID == pinned {
		t.Fatal("sticky token stayed on a blocked instance")
	}
	if !rb.Rebound {
		t.Error("expected rebound after the pinned instance was blocked")
	}
}

func TestMetricsEndpoint(t *testing.T) {
	srv, _ := newTestServer(t)
	register(t, srv.URL, "api", "a", "10.0.0.1", "2.1.0")
	register(t, srv.URL, "api", "b", "10.0.0.2", "2.1.0")
	register(t, srv.URL, "api", "c", "10.0.0.3", "1.0.0")
	blockInst(t, srv.URL, "api", "b", true)

	// Generate a request counter.
	getJSON(t, srv.URL+"/v1/discover/api/pick?client=tester", nil)

	resp, err := http.Get(srv.URL + "/metrics") // open, no auth
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	text := string(body)

	// a is up&unblocked, b is blocked -> up=1 for version 2.1.0.
	if !strings.Contains(text, `discovery_up{service="api",version="2.1.0"} 1`) {
		t.Errorf("missing/incorrect discovery_up for 2.1.0:\n%s", text)
	}
	if !strings.Contains(text, `discovery_up{service="api",version="1.0.0"} 1`) {
		t.Errorf("missing discovery_up for 1.0.0:\n%s", text)
	}
	if !strings.Contains(text, `discovery_blocked{service="api"} 1`) {
		t.Errorf("missing discovery_blocked:\n%s", text)
	}
	if !strings.Contains(text, `discovery_requests_total{service="api",kind="pick"}`) {
		t.Errorf("missing discovery_requests_total:\n%s", text)
	}
}

func TestStatsEndpoint(t *testing.T) {
	srv, _ := newTestServer(t)
	register(t, srv.URL, "api", "a", "10.0.0.1", "2.1.0")

	// Two lookups from a named client.
	req, _ := http.NewRequest(http.MethodGet, srv.URL+"/v1/discover/api/pick", nil)
	req.Header.Set("X-Discovery-Client", "billing-worker")
	resp, _ := http.DefaultClient.Do(req)
	resp.Body.Close()
	getJSON(t, srv.URL+"/v1/discover/api?client=billing-worker", nil)

	var snap stats.Snapshot
	getJSON(t, srv.URL+"/v1/stats", &snap)
	if len(snap.Feed) < 2 {
		t.Fatalf("want >=2 feed entries, got %d", len(snap.Feed))
	}
	foundClient := false
	for _, c := range snap.Clients {
		if c.Name == "billing-worker" {
			foundClient = true
		}
	}
	if !foundClient {
		t.Errorf("client billing-worker not tracked: %+v", snap.Clients)
	}
	if len(snap.Services) == 0 {
		t.Error("expected service stats")
	}
}
