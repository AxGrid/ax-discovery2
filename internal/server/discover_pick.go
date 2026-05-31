package server

import (
	"fmt"
	"math/rand/v2"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/axgrid/discovery2/internal/model"
	"github.com/axgrid/discovery2/internal/semver"
	"github.com/axgrid/discovery2/internal/stats"
)

const defaultAffinityTTL = 20 * time.Minute

// versionConstraint reads and validates the ?version= query param. It returns
// ("", true) when absent, (expr, true) when valid, and writes a 400 + returns
// ("", false) when the expression doesn't parse — so callers can `if !ok { return }`.
func versionConstraint(w http.ResponseWriter, r *http.Request) (string, bool) {
	c := strings.TrimSpace(r.URL.Query().Get("version"))
	if c == "" {
		return "", true
	}
	if !semver.ValidConstraint(c) {
		writeErr(w, http.StatusBadRequest, fmt.Errorf("invalid version constraint %q", c))
		return "", false
	}
	return c, true
}

// upInstances filters to instances eligible for discovery: UP, not blocked by
// an operator, and (when supplied) satisfying the semver constraint. The
// constraint must already be validated.
func upInstances(insts []model.Instance, constraint string) []model.Instance {
	out := make([]model.Instance, 0, len(insts))
	for _, i := range insts {
		if i.Status != model.StatusUp || i.Blocked {
			continue
		}
		if constraint != "" {
			ok, _ := semver.Match(i.Version, constraint)
			if !ok {
				continue
			}
		}
		out = append(out, i)
	}
	return out
}

// writeDiscover renders a list of instances either as full objects (default)
// or, with ?format=addr, as a flat ["host:port", …] string list.
func (s *Server) writeDiscover(w http.ResponseWriter, r *http.Request, insts []model.Instance) {
	if strings.EqualFold(r.URL.Query().Get("format"), "addr") {
		iface := strings.TrimSpace(r.URL.Query().Get("iface"))
		addrs := make([]string, 0, len(insts))
		for i := range insts {
			addrs = append(addrs, addressFor(insts[i], iface))
		}
		writeJSON(w, http.StatusOK, addrs)
		return
	}
	writeJSON(w, http.StatusOK, insts)
}

// PickResult is the response of /discover/{name}/pick — one chosen instance
// plus a ready-to-use address/url so a caller doesn't have to resolve an
// interface itself.
type PickResult struct {
	Address  string          `json:"address"`
	URL      string          `json:"url,omitempty"`
	Sticky   bool            `json:"sticky,omitempty"`  // bound via ?token=
	Rebound  bool            `json:"rebound,omitempty"` // previous binding was dead and got re-pinned
	Instance *model.Instance `json:"instance"`
}

// discoverPick selects a single UP instance of a service for the caller.
//
//	?version=<constraint>  same semver filter as /discover.
//	?iface=<name>          which interface to resolve into address/url.
//	?token=<opaque>        sticky balancing: the same token keeps landing on
//	                       the same instance until it idles past AffinityTTL.
//	                       If that instance goes DOWN/away, it re-binds to a
//	                       healthy one (rebound=true).
//
// Without a token, selection is weighted-random over Weight.
func (s *Server) discoverPick(w http.ResponseWriter, r *http.Request) {
	if !requireRead(w, r) {
		return
	}
	constraint, ok := versionConstraint(w, r)
	if !ok {
		return
	}
	name := r.PathValue("name")
	iface := strings.TrimSpace(r.URL.Query().Get("iface"))
	token := strings.TrimSpace(r.URL.Query().Get("token"))

	insts, err := s.store.ListInstances(name)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	candidates := upInstances(insts, constraint)
	if len(candidates) == 0 {
		writeErr(w, http.StatusServiceUnavailable, fmt.Errorf("no healthy instances for %q", name))
		return
	}

	var (
		chosen  *model.Instance
		sticky  bool
		rebound bool
	)
	if token != "" {
		chosen, sticky, rebound = s.stickyPick(name, token, candidates)
	} else {
		chosen = weightedPick(candidates)
	}
	if chosen == nil {
		writeErr(w, http.StatusServiceUnavailable, fmt.Errorf("no healthy instances for %q", name))
		return
	}

	addr := addressFor(*chosen, iface)
	s.stats.Record(stats.Lookup{
		Client:   clientName(r),
		Service:  name,
		Kind:     stats.KindPick,
		Version:  constraint,
		Count:    1,
		Instance: chosen.ID,
		Address:  addr,
	})
	writeJSON(w, http.StatusOK, PickResult{
		Address:  addr,
		URL:      urlFor(*chosen, iface),
		Sticky:   sticky,
		Rebound:  rebound,
		Instance: chosen,
	})
}

// clientName identifies the caller for the request feed / client map. Clients
// self-identify via the X-Discovery-Client header (set by discovery2-client) or
// a ?client= query param; absent that we fall back to the remote IP so the feed
// still groups by origin.
func clientName(r *http.Request) string {
	if h := strings.TrimSpace(r.Header.Get("X-Discovery-Client")); h != "" {
		return h
	}
	if q := strings.TrimSpace(r.URL.Query().Get("client")); q != "" {
		return q
	}
	if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil && host != "" {
		return host
	}
	return strings.TrimSpace(r.RemoteAddr)
}

// stickyPick resolves a token to an instance, honouring an existing binding
// when its target is still a live candidate and re-binding otherwise. The
// returned pointer aliases into candidates.
func (s *Server) stickyPick(service, token string, candidates []model.Instance) (chosen *model.Instance, sticky, rebound bool) {
	ttl := s.affinityTTL()
	now := time.Now().UTC()

	if aff, err := s.store.GetAffinity(service, token); err == nil {
		for i := range candidates {
			if candidates[i].ID == aff.InstanceID {
				// Slide the idle window forward, but throttle DB writes to a
				// few per window (not one per request), and never gossip a
				// pure refresh — only create/re-bind replicates.
				if now.Sub(aff.LastSeen) > ttl/4 {
					aff.LastSeen = now
					aff.ExpiresAt = now.Add(ttl)
					_ = s.store.PutAffinity(aff, false)
				}
				return &candidates[i], true, false
			}
		}
		// Bound instance is gone / down / no longer matches the constraint.
		rebound = true
	}

	chosen = weightedPick(candidates)
	if chosen == nil {
		return nil, false, rebound
	}
	_ = s.store.PutAffinity(&model.Affinity{
		Token:       token,
		ServiceName: service,
		InstanceID:  chosen.ID,
		CreatedAt:   now,
		LastSeen:    now,
		ExpiresAt:   now.Add(ttl),
	}, true)
	return chosen, true, rebound
}

func (s *Server) affinityTTL() time.Duration {
	if s.cfg.AffinityTTL > 0 {
		return s.cfg.AffinityTTL
	}
	return defaultAffinityTTL
}

// weightedPick chooses one instance with probability proportional to Weight
// (a non-positive weight counts as 1). Returns nil for an empty slice.
func weightedPick(insts []model.Instance) *model.Instance {
	if len(insts) == 0 {
		return nil
	}
	total := 0
	for i := range insts {
		total += effectiveWeight(insts[i].Weight)
	}
	n := rand.IntN(total)
	for i := range insts {
		w := effectiveWeight(insts[i].Weight)
		if n < w {
			return &insts[i]
		}
		n -= w
	}
	return &insts[len(insts)-1]
}

func effectiveWeight(w int) int {
	if w <= 0 {
		return 1
	}
	return w
}

// addressFor returns "host:port" for the named interface, or the bare Address
// when no interface is requested or the named one isn't present.
func addressFor(inst model.Instance, iface string) string {
	if iface != "" {
		for _, it := range inst.Interfaces {
			if strings.EqualFold(it.Name, iface) {
				return fmt.Sprintf("%s:%d", inst.Address, it.Port)
			}
		}
	}
	return inst.Address
}

// urlFor builds scheme://host:port/path for the named interface (or the first
// interface when iface is empty). Returns "" when there's nothing to resolve.
func urlFor(inst model.Instance, iface string) string {
	for _, it := range inst.Interfaces {
		if iface != "" && !strings.EqualFold(it.Name, iface) {
			continue
		}
		scheme := "http"
		switch strings.ToLower(it.Protocol) {
		case "https", "wss":
			scheme = "https"
		}
		if it.TLS {
			scheme = "https"
		}
		return fmt.Sprintf("%s://%s:%d%s", scheme, inst.Address, it.Port, it.Path)
	}
	return ""
}
