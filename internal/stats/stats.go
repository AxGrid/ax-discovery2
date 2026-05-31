// Package stats is an in-memory, node-local collector for discovery lookups
// (/discover, /pick). It powers the dashboard's live request view — per-service
// counters, a rolling requests-per-second sparkline, a recent-lookup feed, and
// a "which client asked for which service / got which instance" map — plus the
// request counters exported on /metrics.
//
// It is intentionally NOT persisted or replicated: each node reports the
// traffic it personally served. Cluster-wide health gauges come from the
// replicated store instead.
package stats

import (
	"sort"
	"sync"
	"time"
)

// Lookup kinds.
const (
	KindDiscover = "discover"
	KindPick     = "pick"
	KindTag      = "tag"
)

const (
	ringSeconds     = 120 // seconds of per-second history retained per service
	defaultFeedSize = 200 // recent lookups kept for the live feed
)

// Lookup is one recorded discovery request.
type Lookup struct {
	Time     time.Time `json:"time"`
	Client   string    `json:"client,omitempty"`
	Service  string    `json:"service"`
	Kind     string    `json:"kind"`
	Version  string    `json:"version,omitempty"`  // version constraint, if any
	Count    int       `json:"count"`              // instances returned
	Instance string    `json:"instance,omitempty"` // chosen instance id (pick only)
	Address  string    `json:"address,omitempty"`  // chosen address (pick only)
}

// ring is a fixed-size per-second bucket counter used for rps + sparklines.
// Buckets are reset lazily: a bucket whose stored second is stale is treated
// as empty, so no background sweeping is needed.
type ring struct {
	counts [ringSeconds]int
	secs   [ringSeconds]int64
}

func (r *ring) incr(now int64) {
	i := int(((now % ringSeconds) + ringSeconds) % ringSeconds)
	if r.secs[i] != now {
		r.secs[i] = now
		r.counts[i] = 0
	}
	r.counts[i]++
}

// series returns the last span seconds of counts, oldest first, zero-filled.
func (r *ring) series(now int64, span int) []int {
	if span > ringSeconds {
		span = ringSeconds
	}
	out := make([]int, span)
	for k := 0; k < span; k++ {
		sec := now - int64(span-1-k)
		i := int(((sec % ringSeconds) + ringSeconds) % ringSeconds)
		if r.secs[i] == sec {
			out[k] = r.counts[i]
		}
	}
	return out
}

func (r *ring) rate(now int64, window int) float64 {
	if window <= 0 {
		window = 1
	}
	sum := 0
	for _, v := range r.series(now, window) {
		sum += v
	}
	return float64(sum) / float64(window)
}

type svcStat struct {
	counts map[string]int64 // kind -> total
	ring   ring
}

type clientStat struct {
	total        int64
	lastSeen     time.Time
	services     map[string]int64  // service -> count
	lastInstance map[string]string // service -> last chosen instance id
}

// Collector accumulates lookups. Safe for concurrent use.
type Collector struct {
	mu       sync.Mutex
	feedSize int
	svc      map[string]*svcStat
	feed     []Lookup
	clients  map[string]*clientStat
}

func New() *Collector {
	return &Collector{
		feedSize: defaultFeedSize,
		svc:      map[string]*svcStat{},
		clients:  map[string]*clientStat{},
	}
}

// Record ingests one lookup.
func (c *Collector) Record(l Lookup) {
	if c == nil {
		return
	}
	if l.Time.IsZero() {
		l.Time = time.Now().UTC()
	}
	sec := l.Time.Unix()

	c.mu.Lock()
	defer c.mu.Unlock()

	ss := c.svc[l.Service]
	if ss == nil {
		ss = &svcStat{counts: map[string]int64{}}
		c.svc[l.Service] = ss
	}
	ss.counts[l.Kind]++
	ss.ring.incr(sec)

	c.feed = append(c.feed, l)
	if len(c.feed) > c.feedSize {
		c.feed = c.feed[len(c.feed)-c.feedSize:]
	}

	if l.Client != "" {
		cs := c.clients[l.Client]
		if cs == nil {
			cs = &clientStat{services: map[string]int64{}, lastInstance: map[string]string{}}
			c.clients[l.Client] = cs
		}
		cs.total++
		cs.lastSeen = l.Time
		cs.services[l.Service]++
		if l.Instance != "" {
			cs.lastInstance[l.Service] = l.Instance
		}
	}
}

// --- snapshot for the UI ---

type ServiceStat struct {
	Service   string           `json:"service"`
	Total     int64            `json:"total"`
	ByKind    map[string]int64 `json:"byKind"`
	RPS       float64          `json:"rps"`
	Sparkline []int            `json:"sparkline"`
}

type ClientServiceStat struct {
	Service      string `json:"service"`
	Count        int64  `json:"count"`
	LastInstance string `json:"lastInstance,omitempty"`
}

type ClientStat struct {
	Name     string              `json:"name"`
	Total    int64               `json:"total"`
	LastSeen time.Time           `json:"lastSeen"`
	Services []ClientServiceStat `json:"services"`
}

type Snapshot struct {
	Services    []ServiceStat `json:"services"`
	Clients     []ClientStat  `json:"clients"`
	Feed        []Lookup      `json:"feed"`
	GeneratedAt time.Time     `json:"generatedAt"`
}

// Snapshot renders the current view. rateWindow is the rps averaging window in
// seconds; sparkSpan is how many trailing seconds of sparkline to emit.
func (c *Collector) Snapshot(rateWindow, sparkSpan int) Snapshot {
	now := time.Now().Unix()
	c.mu.Lock()
	defer c.mu.Unlock()

	svcs := make([]ServiceStat, 0, len(c.svc))
	for name, ss := range c.svc {
		bk := make(map[string]int64, len(ss.counts))
		var total int64
		for k, v := range ss.counts {
			bk[k] = v
			total += v
		}
		svcs = append(svcs, ServiceStat{
			Service:   name,
			Total:     total,
			ByKind:    bk,
			RPS:       ss.ring.rate(now, rateWindow),
			Sparkline: ss.ring.series(now, sparkSpan),
		})
	}
	sort.Slice(svcs, func(i, j int) bool {
		if svcs[i].RPS != svcs[j].RPS {
			return svcs[i].RPS > svcs[j].RPS
		}
		return svcs[i].Service < svcs[j].Service
	})

	clients := make([]ClientStat, 0, len(c.clients))
	for name, cs := range c.clients {
		svcList := make([]ClientServiceStat, 0, len(cs.services))
		for svc, n := range cs.services {
			svcList = append(svcList, ClientServiceStat{Service: svc, Count: n, LastInstance: cs.lastInstance[svc]})
		}
		sort.Slice(svcList, func(i, j int) bool { return svcList[i].Count > svcList[j].Count })
		clients = append(clients, ClientStat{Name: name, Total: cs.total, LastSeen: cs.lastSeen, Services: svcList})
	}
	sort.Slice(clients, func(i, j int) bool { return clients[i].Total > clients[j].Total })

	// Feed newest-first.
	feed := make([]Lookup, len(c.feed))
	for i, l := range c.feed {
		feed[len(c.feed)-1-i] = l
	}

	return Snapshot{Services: svcs, Clients: clients, Feed: feed, GeneratedAt: time.Now().UTC()}
}

// RequestTotals returns per-service, per-kind request counts for /metrics.
func (c *Collector) RequestTotals() map[string]map[string]int64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make(map[string]map[string]int64, len(c.svc))
	for name, ss := range c.svc {
		m := make(map[string]int64, len(ss.counts))
		for k, v := range ss.counts {
			m[k] = v
		}
		out[name] = m
	}
	return out
}
