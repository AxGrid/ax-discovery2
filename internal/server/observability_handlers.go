package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strings"

	"github.com/axgrid/discovery2/internal/model"
)

// --- block / unblock ---

type blockInput struct {
	Blocked bool `json:"blocked"`
}

// blockInstance toggles the operator kill-switch. Requires write on the service
// but — unlike a normal edit — works on managed (self-registered) instances,
// because blocking is an operator action that the owning client must not be
// able to override on its next heartbeat.
func (s *Server) blockInstance(w http.ResponseWriter, r *http.Request) {
	if !s.allowInstanceWrite(w, r) {
		return
	}
	name := r.PathValue("name")
	id := r.PathValue("id")
	var in blockInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	inst, err := s.store.SetBlocked(name, id, in.Blocked)
	if err != nil {
		safeStoreErr(w, err)
		return
	}
	action := model.AuditInstanceUnblocked
	if in.Blocked {
		action = model.AuditInstanceBlocked
	}
	s.audit(r, action, name, "instance", map[string]interface{}{"id": id})
	writeJSON(w, http.StatusOK, inst)
}

// --- live request stats (UI) ---

func (s *Server) listStats(w http.ResponseWriter, r *http.Request) {
	if !requireRead(w, r) {
		return
	}
	// rps averaged over 10s; sparkline of the last 60s.
	writeJSON(w, http.StatusOK, s.stats.Snapshot(10, 60))
}

// --- Prometheus metrics (open, cluster-wide) ---

// metrics renders a Prometheus text-format exposition. Health gauges are
// cluster-wide (derived from the replicated store, which every node holds in
// full); request counters are node-local (this node's served traffic).
//
// Registered outside the /v1 auth pipeline so a scraper needs no credentials.
func (s *Server) metrics(w http.ResponseWriter, r *http.Request) {
	insts, err := s.store.ListAllInstances()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	// (service,version) -> up&!blocked count, materialised for every combo that
	// has any instance so an all-down version still reports 0 (easy ==0 alarm).
	up := map[svKey]int{}
	byStatus := map[sv2]int{}
	blocked := map[string]int{}
	for i := range insts {
		k := svKey{insts[i].ServiceName, insts[i].Version}
		if _, ok := up[k]; !ok {
			up[k] = 0
		}
		if insts[i].Status == model.StatusUp && !insts[i].Blocked {
			up[k]++
		}
		byStatus[sv2{insts[i].ServiceName, string(insts[i].Status)}]++
		if insts[i].Blocked {
			blocked[insts[i].ServiceName]++
		}
	}

	var b strings.Builder
	b.WriteString("# HELP discovery_up Number of UP, non-blocked instances per service and version (cluster-wide).\n")
	b.WriteString("# TYPE discovery_up gauge\n")
	for _, k := range sortedSV(up) {
		fmt.Fprintf(&b, "discovery_up{service=%q,version=%q} %d\n", k.service, k.version, up[k])
	}

	b.WriteString("# HELP discovery_instances Number of instances per service and status (cluster-wide).\n")
	b.WriteString("# TYPE discovery_instances gauge\n")
	for _, k := range sortedSV2(byStatus) {
		fmt.Fprintf(&b, "discovery_instances{service=%q,status=%q} %d\n", k.service, k.status, byStatus[k])
	}

	b.WriteString("# HELP discovery_blocked Number of operator-blocked instances per service (cluster-wide).\n")
	b.WriteString("# TYPE discovery_blocked gauge\n")
	for _, svc := range sortedKeys(blocked) {
		fmt.Fprintf(&b, "discovery_blocked{service=%q} %d\n", svc, blocked[svc])
	}

	b.WriteString("# HELP discovery_requests_total Discovery lookups served by this node.\n")
	b.WriteString("# TYPE discovery_requests_total counter\n")
	totals := s.stats.RequestTotals()
	for _, svc := range sortedKeys2(totals) {
		kinds := totals[svc]
		ks := make([]string, 0, len(kinds))
		for k := range kinds {
			ks = append(ks, k)
		}
		sort.Strings(ks)
		for _, kind := range ks {
			fmt.Fprintf(&b, "discovery_requests_total{service=%q,kind=%q} %d\n", svc, kind, kinds[kind])
		}
	}

	nodes := 1
	if s.cluster != nil {
		if n := len(s.cluster.Members()); n > 0 {
			nodes = n
		}
	}
	b.WriteString("# HELP discovery_cluster_nodes Number of known cluster members (including self).\n")
	b.WriteString("# TYPE discovery_cluster_nodes gauge\n")
	fmt.Fprintf(&b, "discovery_cluster_nodes %d\n", nodes)

	w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
	_, _ = w.Write([]byte(b.String()))
}

type svKey struct{ service, version string }
type sv2 struct{ service, status string }

func sortedSV(m map[svKey]int) []svKey {
	keys := make([]svKey, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool {
		if keys[i].service != keys[j].service {
			return keys[i].service < keys[j].service
		}
		return keys[i].version < keys[j].version
	})
	return keys
}

func sortedSV2(m map[sv2]int) []sv2 {
	keys := make([]sv2, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool {
		if keys[i].service != keys[j].service {
			return keys[i].service < keys[j].service
		}
		return keys[i].status < keys[j].status
	})
	return keys
}

func sortedKeys(m map[string]int) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func sortedKeys2(m map[string]map[string]int64) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
