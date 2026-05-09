package health

import (
	"context"
	"crypto/tls"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/axgrid/discovery2/internal/model"
	"github.com/axgrid/discovery2/internal/store"
)

// Checker drives liveness checks per the instance's CheckMode.
//
// Modes:
//   - heartbeat (default): TTL sweep — flip to "down" if last heartbeat is too old
//   - http / tcp: active probe; mark up/down based on probe result
//   - none: never auto-change status
type Checker struct {
	store         *store.Store
	log           *slog.Logger
	tickInterval  time.Duration
	probeTimeout  time.Duration

	httpClient *http.Client
	lastProbed sync.Map // instance "service/id" -> time.Time
}

type Config struct {
	Logger       *slog.Logger
	TickInterval time.Duration // default 5s — how often we re-evaluate every instance
	ProbeTimeout time.Duration // default 3s
}

func New(s *store.Store, cfg Config) *Checker {
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	if cfg.TickInterval == 0 {
		cfg.TickInterval = 5 * time.Second
	}
	if cfg.ProbeTimeout == 0 {
		cfg.ProbeTimeout = 3 * time.Second
	}
	return &Checker{
		store:        s,
		log:          cfg.Logger,
		tickInterval: cfg.TickInterval,
		probeTimeout: cfg.ProbeTimeout,
		httpClient: &http.Client{
			Timeout: cfg.ProbeTimeout,
			Transport: &http.Transport{
				TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
			},
		},
	}
}

// Run blocks until ctx is cancelled.
func (c *Checker) Run(ctx context.Context) {
	t := time.NewTicker(c.tickInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-t.C:
			c.tick(ctx, now)
		}
	}
}

func (c *Checker) tick(ctx context.Context, now time.Time) {
	insts, err := c.store.ListAllInstances()
	if err != nil {
		c.log.Error("health list", "err", err)
		return
	}

	var wg sync.WaitGroup
	probeSem := make(chan struct{}, 32)

	for _, inst := range insts {
		inst := inst
		switch inst.EffectiveCheckMode() {
		case model.CheckHeartbeat:
			c.evalHeartbeat(now, &inst)
		case model.CheckHTTP, model.CheckTCP:
			if !c.dueForProbe(&inst, now) {
				continue
			}
			wg.Add(1)
			probeSem <- struct{}{}
			go func() {
				defer wg.Done()
				defer func() { <-probeSem }()
				c.evalProbe(ctx, &inst)
			}()
		case model.CheckNone:
			// nothing to do
		}
	}
	wg.Wait()
}

// evalHeartbeat flips an instance to "down" if its TTL has expired.
// Up→down transition: on TTL expiry. Down→up never happens here — the
// instance must heartbeat to recover.
func (c *Checker) evalHeartbeat(now time.Time, inst *model.Instance) {
	if !inst.Expired(now) {
		return
	}
	if inst.Status == model.StatusDown {
		return
	}
	if _, err := c.store.SetStatus(inst.ServiceName, inst.ID, model.StatusDown); err != nil {
		c.log.Warn("ttl set-down", "service", inst.ServiceName, "id", inst.ID, "err", err)
	} else {
		c.log.Info("ttl expired", "service", inst.ServiceName, "id", inst.ID)
	}
}

// dueForProbe spaces probes per the instance's CheckIntervalSec (default 15s).
func (c *Checker) dueForProbe(inst *model.Instance, now time.Time) bool {
	interval := time.Duration(inst.CheckIntervalSec) * time.Second
	if interval <= 0 {
		interval = 15 * time.Second
	}
	key := inst.ServiceName + "/" + inst.ID
	v, ok := c.lastProbed.Load(key)
	if ok {
		if last, _ := v.(time.Time); now.Sub(last) < interval {
			return false
		}
	}
	c.lastProbed.Store(key, now)
	return true
}

// ProbeResult is re-exported from model so existing callers can keep using
// the short name without importing model.
type ProbeResult = model.ProbeResult

// CheckInstance runs the appropriate probe for the instance's CheckMode and
// returns whether it passed plus a per-interface report. It does NOT update
// the store — the caller decides whether to apply the status (the background
// loop does, the on-demand /check endpoint does).
//
// For CheckHTTP / CheckTCP every relevant interface is probed and ALL must
// pass for the instance to be considered up. This matches user expectations
// when an instance exposes multiple interfaces (e.g. WEB + API) — if API
// returns 404, the instance shouldn't be reported as healthy.
func (c *Checker) CheckInstance(ctx context.Context, inst *model.Instance) (bool, []ProbeResult) {
	switch inst.EffectiveCheckMode() {
	case model.CheckHTTP:
		return c.checkHTTPAll(ctx, inst)
	case model.CheckTCP:
		return c.checkTCPAll(ctx, inst)
	case model.CheckHeartbeat:
		ok := !inst.Expired(time.Now())
		err := ""
		if !ok {
			err = "heartbeat TTL expired"
		}
		return ok, []ProbeResult{{Interface: "heartbeat", OK: ok, Error: err}}
	case model.CheckNone:
		return true, []ProbeResult{{Interface: "none", OK: true}}
	}
	return true, nil
}

func (c *Checker) evalProbe(ctx context.Context, inst *model.Instance) {
	ok, results := c.CheckInstance(ctx, inst)
	check := &model.InstanceCheck{
		Timestamp: time.Now().UTC(),
		OK:        ok,
		Mode:      inst.EffectiveCheckMode(),
		Results:   results,
	}
	if err := c.store.SetLastCheck(inst.ServiceName, inst.ID, check); err != nil {
		c.log.Warn("probe set-last-check", "service", inst.ServiceName, "id", inst.ID, "err", err)
	}
	desired := model.StatusUp
	if !ok {
		desired = model.StatusDown
	}
	if inst.Status == desired {
		return
	}
	if _, err := c.store.SetStatus(inst.ServiceName, inst.ID, desired); err != nil {
		c.log.Warn("probe set-status", "service", inst.ServiceName, "id", inst.ID, "err", err)
	}
}

// checkHTTPAll probes every http/https/ws/wss interface. All must pass.
func (c *Checker) checkHTTPAll(ctx context.Context, inst *model.Instance) (bool, []ProbeResult) {
	results := make([]ProbeResult, 0, len(inst.Interfaces))
	allOK := true
	any := false
	for _, it := range inst.Interfaces {
		switch strings.ToLower(it.Protocol) {
		case "http", "https", "ws", "wss":
		default:
			continue
		}
		any = true
		r := c.probeHTTP(ctx, inst.Address, it)
		r.Interface = it.Name
		results = append(results, r)
		if !r.OK {
			allOK = false
		}
	}
	if !any {
		return false, []ProbeResult{{Interface: "(none)", OK: false, Error: "no HTTP-ish interfaces to probe"}}
	}
	return allOK, results
}

// checkTCPAll probes every interface's port. All must pass.
func (c *Checker) checkTCPAll(ctx context.Context, inst *model.Instance) (bool, []ProbeResult) {
	if len(inst.Interfaces) == 0 {
		return false, []ProbeResult{{Interface: "(none)", OK: false, Error: "no interfaces to probe"}}
	}
	results := make([]ProbeResult, 0, len(inst.Interfaces))
	allOK := true
	for _, it := range inst.Interfaces {
		r := c.probeTCP(ctx, inst.Address, it.Port)
		r.Interface = it.Name
		results = append(results, r)
		if !r.OK {
			allOK = false
		}
	}
	return allOK, results
}

func (c *Checker) probeTCP(ctx context.Context, host string, port int) ProbeResult {
	addr := net.JoinHostPort(host, fmt.Sprintf("%d", port))
	r := ProbeResult{URL: "tcp://" + addr}
	ctx, cancel := context.WithTimeout(ctx, c.probeTimeout)
	defer cancel()
	start := time.Now()
	d := net.Dialer{}
	conn, err := d.DialContext(ctx, "tcp", addr)
	r.LatencyMS = time.Since(start).Milliseconds()
	if err != nil {
		r.Error = err.Error()
		return r
	}
	_ = conn.Close()
	r.OK = true
	return r
}

func (c *Checker) probeHTTP(ctx context.Context, host string, it model.Interface) ProbeResult {
	url := buildProbeURL(host, it)
	r := ProbeResult{URL: url}
	if url == "" {
		r.Error = "could not build probe URL"
		return r
	}
	ctx, cancel := context.WithTimeout(ctx, c.probeTimeout)
	defer cancel()
	start := time.Now()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		r.Error = err.Error()
		r.LatencyMS = time.Since(start).Milliseconds()
		return r
	}
	resp, err := c.httpClient.Do(req)
	r.LatencyMS = time.Since(start).Milliseconds()
	if err != nil {
		r.Error = err.Error()
		return r
	}
	defer resp.Body.Close()
	r.HTTPStatus = resp.StatusCode
	r.OK = resp.StatusCode >= 200 && resp.StatusCode < 400
	if !r.OK {
		r.Error = fmt.Sprintf("HTTP %d", resp.StatusCode)
	}
	return r
}

// buildProbeURL is the single source of truth for the URL we hit during an
// HTTP/HTTPS health check. Rules:
//
//   - If HealthURL is a fully-qualified URL ("http://..." / "https://..."),
//     use it as-is. This is the override for "probe a different host", e.g.
//     a service fronted by a reverse proxy on a different domain.
//   - Otherwise build "scheme://host[:port]/path", where:
//     - scheme is derived from Interface.Protocol / TLS
//     - port is omitted when 0 / 80 (http) / 443 (https) — i.e. when the
//       implicit scheme default is right anyway. This matters because
//       services registered with port 0 (proxy-fronted) would otherwise get
//       URLs like "https://host:0/" which fail.
//     - path is HealthURL → Path → "/" (empty means "probe the root and
//       accept any 2xx-3xx").
func buildProbeURL(host string, it model.Interface) string {
	if it.HealthURL != "" {
		l := strings.ToLower(it.HealthURL)
		if strings.HasPrefix(l, "http://") || strings.HasPrefix(l, "https://") {
			return it.HealthURL
		}
	}

	scheme := "http"
	switch strings.ToLower(it.Protocol) {
	case "https", "wss":
		scheme = "https"
	}
	if it.TLS {
		scheme = "https"
	}

	path := it.HealthURL
	if path == "" {
		path = it.Path
	}
	if path == "" {
		path = "/"
	}
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}

	port := it.Port
	defaultPort := port == 0 ||
		(scheme == "http" && port == 80) ||
		(scheme == "https" && port == 443)
	if defaultPort {
		return fmt.Sprintf("%s://%s%s", scheme, host, path)
	}
	return fmt.Sprintf("%s://%s:%d%s", scheme, host, port, path)
}
