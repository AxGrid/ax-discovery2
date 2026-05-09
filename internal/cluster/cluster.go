package cluster

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/hashicorp/memberlist"

	"github.com/axgrid/discovery2/internal/model"
	"github.com/axgrid/discovery2/internal/store"
)

// Cluster keeps multiple discovery nodes in sync over gossip.
//
// Strategy:
//   - hashicorp/memberlist for membership and best-effort broadcast of small events
//   - on join, the new node pulls a full snapshot from a random peer over HTTP
//   - periodic anti-entropy: every N seconds, exchange an instance digest with one peer
//
// Conflict resolution: last-write-wins on UpdatedAt.
type Cluster struct {
	cfg        Config
	log        *slog.Logger
	store      *store.Store
	list       *memberlist.Memberlist
	delegate   *delegate
	broadcasts *memberlist.TransmitLimitedQueue

	httpClient *http.Client

	mu      sync.RWMutex
	members map[string]string // nodeID -> apiAddr (host:port)
}

type Config struct {
	NodeID      string
	BindAddr    string // e.g. 0.0.0.0
	BindPort    int    // gossip UDP/TCP port
	AdvertiseIP string // optional, otherwise discovered
	AdvertiseAPI string // host:port other nodes use to reach our HTTP API
	Seeds       []string
	SyncToken   string // shared secret for /cluster/* endpoints
	Logger      *slog.Logger
}

func New(s *store.Store, cfg Config) (*Cluster, error) {
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	c := &Cluster{
		cfg:        cfg,
		log:        cfg.Logger,
		store:      s,
		httpClient: &http.Client{Timeout: 10 * time.Second},
		members:    make(map[string]string),
	}

	mlCfg := memberlist.DefaultLANConfig()
	mlCfg.Name = cfg.NodeID
	mlCfg.BindAddr = cfg.BindAddr
	mlCfg.BindPort = cfg.BindPort
	mlCfg.AdvertisePort = cfg.BindPort
	if cfg.AdvertiseIP != "" {
		mlCfg.AdvertiseAddr = cfg.AdvertiseIP
	}
	mlCfg.LogOutput = io.Discard

	c.delegate = &delegate{c: c, meta: encodeMeta(cfg.AdvertiseAPI)}
	mlCfg.Delegate = c.delegate
	mlCfg.Events = &events{c: c}

	list, err := memberlist.Create(mlCfg)
	if err != nil {
		return nil, fmt.Errorf("memberlist create: %w", err)
	}
	c.list = list
	c.broadcasts = &memberlist.TransmitLimitedQueue{
		NumNodes:       func() int { return list.NumMembers() },
		RetransmitMult: 3,
	}

	if len(cfg.Seeds) > 0 {
		n, err := list.Join(cfg.Seeds)
		if err != nil {
			c.log.Warn("memberlist join", "err", err)
		} else {
			c.log.Info("joined cluster", "contacted", n)
		}
	}
	return c, nil
}

// Run subscribes to local store events and broadcasts them, plus periodic anti-entropy.
func (c *Cluster) Run(ctx context.Context) {
	sub := c.store.Subscribe(256)
	defer c.store.Unsubscribe(sub)

	go c.runAntiEntropy(ctx)

	// Initial sync from any known peer.
	go c.bootstrapSync(ctx)

	for {
		select {
		case <-ctx.Done():
			return
		case ev, ok := <-sub.C():
			if !ok {
				return
			}
			if ev.OriginID != "" && ev.OriginID != c.cfg.NodeID {
				// don't re-broadcast events that came from another node
				continue
			}
			ev.OriginID = c.cfg.NodeID
			c.broadcastEvent(ev)
		}
	}
}

func (c *Cluster) Shutdown() error {
	if c.list == nil {
		return nil
	}
	_ = c.list.Leave(2 * time.Second)
	return c.list.Shutdown()
}

func (c *Cluster) Members() []string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	out := make([]string, 0, len(c.members))
	for id, addr := range c.members {
		out = append(out, fmt.Sprintf("%s@%s", id, addr))
	}
	return out
}

// Join contacts the given gossip seeds and merges their cluster state.
// Returns the number of nodes successfully reached.
func (c *Cluster) Join(seeds []string) (int, error) {
	if c.list == nil {
		return 0, fmt.Errorf("cluster not running")
	}
	if len(seeds) == 0 {
		return 0, fmt.Errorf("no seeds")
	}
	n, err := c.list.Join(seeds)
	if err != nil {
		c.log.Warn("memberlist join", "err", err)
		return n, err
	}
	c.log.Info("joined peers", "contacted", n, "seeds", seeds)
	return n, nil
}

func (c *Cluster) broadcastEvent(ev model.Event) {
	buf, err := json.Marshal(ev)
	if err != nil {
		c.log.Warn("broadcast marshal", "err", err)
		return
	}
	c.broadcasts.QueueBroadcast(&simpleBroadcast{msg: buf})
}

func (c *Cluster) bootstrapSync(ctx context.Context) {
	// Wait briefly for memberlist to populate, then pick any peer.
	select {
	case <-ctx.Done():
		return
	case <-time.After(2 * time.Second):
	}
	c.mu.RLock()
	peers := make([]string, 0, len(c.members))
	for id, addr := range c.members {
		if id == c.cfg.NodeID || addr == "" {
			continue
		}
		peers = append(peers, addr)
	}
	c.mu.RUnlock()
	if len(peers) == 0 {
		return
	}
	if err := c.pullSnapshot(ctx, peers[0]); err != nil {
		c.log.Warn("bootstrap snapshot", "peer", peers[0], "err", err)
	} else {
		c.log.Info("bootstrap snapshot ok", "peer", peers[0])
	}
}

func (c *Cluster) runAntiEntropy(ctx context.Context) {
	t := time.NewTicker(30 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			c.mu.RLock()
			var addr string
			for id, a := range c.members {
				if id == c.cfg.NodeID || a == "" {
					continue
				}
				addr = a
				break
			}
			c.mu.RUnlock()
			if addr == "" {
				continue
			}
			if err := c.pullSnapshot(ctx, addr); err != nil {
				c.log.Debug("anti-entropy", "peer", addr, "err", err)
			}
		}
	}
}

func (c *Cluster) pullSnapshot(ctx context.Context, peerAPI string) error {
	url := "http://" + peerAPI + "/cluster/snapshot"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	if c.cfg.SyncToken != "" {
		req.Header.Set("X-Cluster-Token", c.cfg.SyncToken)
	}
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("status %d", resp.StatusCode)
	}
	var snap store.Snapshot
	if err := json.NewDecoder(resp.Body).Decode(&snap); err != nil {
		return err
	}
	for i := range snap.Services {
		ev := model.Event{
			Type:     model.EventServiceUpserted,
			Service:  snap.Services[i].Name,
			Payload:  &snap.Services[i],
			OriginID: "snapshot",
		}
		_ = c.store.ApplyRemote(ev)
	}
	for i := range snap.Instances {
		ev := model.Event{
			Type:     model.EventInstanceUpserted,
			Service:  snap.Instances[i].ServiceName,
			Instance: snap.Instances[i].ID,
			Payload:  &snap.Instances[i],
			OriginID: "snapshot",
		}
		_ = c.store.ApplyRemote(ev)
	}
	return nil
}

// HandleSnapshot serves the local snapshot to peers.
func (c *Cluster) HandleSnapshot(w http.ResponseWriter, r *http.Request) {
	if c.cfg.SyncToken != "" && r.Header.Get("X-Cluster-Token") != c.cfg.SyncToken {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	snap, err := c.store.Snapshot()
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(snap)
}

// --- memberlist plumbing ---

type delegate struct {
	c    *Cluster
	meta []byte
}

func (d *delegate) NodeMeta(limit int) []byte {
	if len(d.meta) > limit {
		return d.meta[:limit]
	}
	return d.meta
}
func (d *delegate) NotifyMsg(b []byte) {
	if len(b) == 0 {
		return
	}
	cp := make([]byte, len(b))
	copy(cp, b)
	var ev model.Event
	if err := json.Unmarshal(cp, &ev); err != nil {
		d.c.log.Warn("gossip decode", "err", err)
		return
	}
	if ev.OriginID == d.c.cfg.NodeID {
		return
	}
	if err := d.c.store.ApplyRemote(ev); err != nil {
		d.c.log.Warn("apply remote", "err", err)
	}
}
func (d *delegate) GetBroadcasts(overhead, limit int) [][]byte {
	return d.c.broadcasts.GetBroadcasts(overhead, limit)
}
func (d *delegate) LocalState(join bool) []byte { return nil }
func (d *delegate) MergeRemoteState(buf []byte, join bool) {}

type events struct{ c *Cluster }

func (e *events) NotifyJoin(n *memberlist.Node) {
	api := decodeMeta(n.Meta)
	e.c.mu.Lock()
	e.c.members[n.Name] = api
	e.c.mu.Unlock()
	e.c.log.Info("peer join", "node", n.Name, "api", api)
}
func (e *events) NotifyLeave(n *memberlist.Node) {
	e.c.mu.Lock()
	delete(e.c.members, n.Name)
	e.c.mu.Unlock()
	e.c.log.Info("peer leave", "node", n.Name)
}
func (e *events) NotifyUpdate(n *memberlist.Node) {
	api := decodeMeta(n.Meta)
	e.c.mu.Lock()
	e.c.members[n.Name] = api
	e.c.mu.Unlock()
}

type simpleBroadcast struct{ msg []byte }

func (b *simpleBroadcast) Invalidates(memberlist.Broadcast) bool { return false }
func (b *simpleBroadcast) Message() []byte                       { return b.msg }
func (b *simpleBroadcast) Finished()                             {}

// We pack the API address into NodeMeta so peers can find each other's HTTP endpoints.
func encodeMeta(apiAddr string) []byte {
	return []byte(apiAddr)
}

func decodeMeta(b []byte) string {
	return string(bytes.TrimSpace(b))
}
