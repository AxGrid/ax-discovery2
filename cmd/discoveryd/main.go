package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"

	"github.com/google/uuid"
	"github.com/joho/godotenv"

	"github.com/axgrid/discovery2/internal/auth"
	"github.com/axgrid/discovery2/internal/cluster"
	"github.com/axgrid/discovery2/internal/health"
	"github.com/axgrid/discovery2/internal/model"
	"github.com/axgrid/discovery2/internal/server"
	"github.com/axgrid/discovery2/internal/store"
	uiembed "github.com/axgrid/discovery2/ui"
)

func main() {
	// Load .env (next to the binary or in the current directory). Already-set
	// env vars win over .env contents — typical 12-factor-ish behavior.
	loadDotEnv()

	var (
		listen      = flag.String("listen", envOr("DISCOVERY_LISTEN", ":8500"), "API listen address")
		dbPath      = flag.String("db", envOr("DISCOVERY_DB", "./discovery.db"), "bbolt database path")
		nodeID      = flag.String("node-id", envOr("DISCOVERY_NODE_ID", hostnameOr("node-1")), "cluster node id")
		gossipBind  = flag.String("gossip-bind", envOr("DISCOVERY_GOSSIP_BIND", "0.0.0.0"), "gossip bind addr")
		gossipPort  = flag.Int("gossip-port", envIntOr("DISCOVERY_GOSSIP_PORT", 7946), "gossip port")
		advAPI      = flag.String("advertise-api", envOr("DISCOVERY_ADVERTISE_API", ""), "host:port peers should use to reach our API")
		advIP       = flag.String("advertise-ip", envOr("DISCOVERY_ADVERTISE_IP", ""), "advertised gossip IP")
		seeds       = flag.String("seeds", envOr("DISCOVERY_SEEDS", ""), "comma-separated peer seeds host:port")
		readToks    = flag.String("read-tokens", envOr("DISCOVERY_READ_TOKENS", ""), "comma-separated read tokens")
		writeToks   = flag.String("write-tokens", envOr("DISCOVERY_WRITE_TOKENS", ""), "comma-separated write tokens")
		adminToks   = flag.String("admin-tokens", envOr("DISCOVERY_ADMIN_TOKENS", ""), "comma-separated admin tokens")
		anon        = flag.Bool("allow-anonymous-read", envBoolOr("DISCOVERY_ALLOW_ANON_READ", true), "allow read without token")
		clusterTok  = flag.String("cluster-token", envOr("DISCOVERY_CLUSTER_TOKEN", ""), "shared token for cluster sync")
		logLevel     = flag.String("log", envOr("DISCOVERY_LOG", "info"), "log level: debug|info|warn|error")
		defaultUser  = flag.String("default-admin-user", envOr("DISCOVERY_DEFAULT_ADMIN_USER", "admin"), "username for the bootstrap admin (only created if no users exist)")
		defaultPass  = flag.String("default-admin-password", envOr("DISCOVERY_DEFAULT_ADMIN_PASSWORD", "admin"), "password for the bootstrap admin")
	)
	flag.Parse()

	log := newLogger(*logLevel)

	st, err := store.Open(*dbPath)
	if err != nil {
		log.Error("open store", "err", err)
		os.Exit(1)
	}
	defer st.Close()

	if err := bootstrapAdmin(st, *defaultUser, *defaultPass, log); err != nil {
		log.Error("bootstrap admin", "err", err)
		os.Exit(1)
	}

	authn := auth.New(auth.Config{
		AllowAnonymousRead: *anon,
		ReadTokens:         splitCSV(*readToks),
		WriteTokens:        splitCSV(*writeToks),
		AdminTokens:        splitCSV(*adminToks),
	})

	hc := health.New(st, health.Config{Logger: log})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var (
		cl  *cluster.Cluster
		err2 error
	)
	advertiseAPI := *advAPI
	if advertiseAPI == "" {
		advertiseAPI = "127.0.0.1" + portOf(*listen)
	}
	cl, err2 = cluster.New(st, cluster.Config{
		NodeID:       *nodeID,
		BindAddr:     *gossipBind,
		BindPort:     *gossipPort,
		AdvertiseIP:  *advIP,
		AdvertiseAPI: advertiseAPI,
		Seeds:        splitCSV(*seeds),
		SyncToken:    *clusterTok,
		Logger:       log,
	})
	if err2 != nil {
		log.Error("cluster init", "err", err2)
		os.Exit(1)
	}

	uiFS, err := fs.Sub(uiembed.UI, "dist")
	if err != nil {
		log.Warn("ui fs", "err", err)
		uiFS = nil
	}

	srv := server.New(server.Config{
		Listen: *listen,
		Logger: log,
		UI:     uiFS,
	}, st, authn, cl, hc)

	var wg sync.WaitGroup
	wg.Add(3)
	go func() { defer wg.Done(); hc.Run(ctx) }()
	go func() { defer wg.Done(); cl.Run(ctx) }()
	go func() {
		defer wg.Done()
		if err := srv.Run(ctx); err != nil && !errors.Is(err, context.Canceled) {
			log.Error("server", "err", err)
			cancel()
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	select {
	case sig := <-stop:
		log.Info("shutting down", "signal", sig.String())
	case <-ctx.Done():
	}
	cancel()
	_ = cl.Shutdown()
	wg.Wait()
}

func newLogger(level string) *slog.Logger {
	var lv slog.Level
	switch strings.ToLower(level) {
	case "debug":
		lv = slog.LevelDebug
	case "warn":
		lv = slog.LevelWarn
	case "error":
		lv = slog.LevelError
	default:
		lv = slog.LevelInfo
	}
	return slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: lv}))
}

func splitCSV(s string) []string {
	if strings.TrimSpace(s) == "" {
		return nil
	}
	parts := strings.Split(s, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}

func envOr(k, def string) string {
	if v, ok := os.LookupEnv(k); ok {
		return v
	}
	return def
}

func envIntOr(k string, def int) int {
	if v, ok := os.LookupEnv(k); ok {
		var n int
		if _, err := fmt.Sscanf(v, "%d", &n); err == nil {
			return n
		}
	}
	return def
}

func envBoolOr(k string, def bool) bool {
	if v, ok := os.LookupEnv(k); ok {
		switch strings.ToLower(v) {
		case "1", "true", "yes", "on":
			return true
		case "0", "false", "no", "off":
			return false
		}
	}
	return def
}

func hostnameOr(def string) string {
	h, err := os.Hostname()
	if err != nil || h == "" {
		return def
	}
	return h
}

func portOf(listen string) string {
	if i := strings.LastIndex(listen, ":"); i >= 0 {
		return listen[i:]
	}
	return ":" + listen
}

// loadDotEnv reads .env from a few sensible locations. Errors are non-fatal —
// the file is optional, and explicit env vars always win.
func loadDotEnv() {
	candidates := []string{".env"}
	if exe, err := os.Executable(); err == nil {
		candidates = append(candidates, exe+"/../.env", exe+"/../../.env")
	}
	for _, p := range candidates {
		if _, err := os.Stat(p); err == nil {
			_ = godotenv.Load(p)
			return
		}
	}
}

// bootstrapAdmin creates the default admin only if no users exist yet. This
// makes a freshly-deployed instance immediately usable without a separate
// init step, while staying out of the way on subsequent boots.
func bootstrapAdmin(st *store.Store, username, password string, log *slog.Logger) error {
	n, err := st.CountUsers()
	if err != nil {
		return err
	}
	if n > 0 {
		return nil
	}
	username = strings.TrimSpace(username)
	if username == "" || password == "" {
		log.Warn("no users in store and no default admin configured — UI login will be impossible until a user is created")
		return nil
	}
	hash, err := auth.HashPassword(password)
	if err != nil {
		return err
	}
	u := &model.User{
		ID:           uuid.NewString(),
		Username:     username,
		DisplayName:  "Administrator",
		IsAdmin:      true,
		PasswordHash: hash,
	}
	if err := st.PutUser(u); err != nil {
		return err
	}
	log.Info("bootstrapped default admin", "username", username)
	return nil
}
