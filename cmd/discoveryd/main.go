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

	axrouter "github.com/axgrid/ax-router2/client"
	"github.com/corp-ui/corp-ui/sdk/go/corp"
	"github.com/joho/godotenv"

	"github.com/axgrid/discovery2/internal/auth"
	"github.com/axgrid/discovery2/internal/cluster"
	"github.com/axgrid/discovery2/internal/health"
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
		logLevel    = flag.String("log", envOr("DISCOVERY_LOG", "info"), "log level: debug|info|warn|error")

		// corp-ui SSO
		corpURL     = flag.String("corp-url", envOr("CORP_URL", ""), "base URL of the corp-ui console (https://console.example.com) — required for cookie-session login and iframe-token validation")
		corpAPIKey  = flag.String("corp-api-key", envOr("CORP_API_KEY", ""), "per-service API key issued by corp-ui (used for verify-password and user search)")
		corpSlug    = flag.String("corp-slug", envOr("CORP_SERVICE_SLUG", "discovery"), "slug under which this discovery instance is registered in corp-ui")
		corpPermKey = flag.String("corp-perm-key", envOr("CORP_PERM_KEY", "discovery"), "permission key in corp-ui whose r/w/a controls discovery access")

		// ax-router2 reverse-router registration (optional)
		axRouterHost  = flag.String("ax-router-host", envOr("AX_ROUTER_HOST", ""), "host of the ax-router2 reverse router (empty = no registration)")
		axRouterToken = flag.String("ax-router-token", envOr("AX_ROUTER_TOKEN", ""), "shared token for ax-router2 registration")
		axRouterName  = flag.String("ax-router-name", envOr("AX_ROUTER_NAME", "discovery"), "service name to advertise on ax-router2")

		// ACME / Let's Encrypt
		acmeEnable   = flag.Bool("acme", envBoolOr("DISCOVERY_ACME_ENABLE", false), "enable automatic HTTPS via Let's Encrypt (requires public DNS + ports 80/443)")
		acmeDomains  = flag.String("acme-domains", envOr("DISCOVERY_ACME_DOMAINS", ""), "comma-separated allow-list of hostnames for which to issue certs")
		acmeEmail    = flag.String("acme-email", envOr("DISCOVERY_ACME_EMAIL", ""), "contact email registered with Let's Encrypt (optional)")
		acmeCache    = flag.String("acme-cache", envOr("DISCOVERY_ACME_CACHE", "./certs"), "directory for issued certificate cache (must persist across restarts)")
		acmeStaging  = flag.Bool("acme-staging", envBoolOr("DISCOVERY_ACME_STAGING", false), "use the Let's Encrypt staging directory (untrusted certs, no rate limits)")
		httpsListen  = flag.String("https-listen", envOr("DISCOVERY_HTTPS_LISTEN", ":443"), "HTTPS bind address when -acme is on")
		httpListen80 = flag.String("acme-http-listen", envOr("DISCOVERY_ACME_HTTP_LISTEN", ":80"), "HTTP bind address for ACME http-01 challenges + redirect (when -acme is on)")
	)
	flag.Parse()

	log := newLogger(*logLevel)

	st, err := store.Open(*dbPath)
	if err != nil {
		log.Error("open store", "err", err)
		os.Exit(1)
	}
	defer st.Close()

	// Build the corp-ui client. Without a URL we run with static-token-only
	// auth — useful for tests and air-gapped clusters where corp-ui isn't
	// available — but UI login is impossible in that mode.
	var corpClient *corp.Client
	if strings.TrimSpace(*corpURL) != "" {
		corpClient = corp.New(*corpURL)
		if strings.TrimSpace(*corpAPIKey) != "" {
			corpClient = corpClient.WithAPIKey(*corpAPIKey)
		}
		log.Info("corp-ui sso configured",
			"corp", *corpURL,
			"slug", *corpSlug,
			"permKey", *corpPermKey,
			"hasApiKey", *corpAPIKey != "")
	} else {
		log.Warn("CORP_URL not set — UI login disabled (static tokens only)")
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
		Corp: auth.CorpConfig{
			Client:      corpClient,
			ServiceSlug: *corpSlug,
			PermKey:     *corpPermKey,
		},
		TLS: server.TLSConfig{
			Enable:             *acmeEnable,
			Listen:             *httpsListen,
			HTTPRedirectListen: *httpListen80,
			Domains:            splitCSV(*acmeDomains),
			Email:              *acmeEmail,
			CacheDir:           *acmeCache,
			Staging:            *acmeStaging,
		},
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

	// ax-router2 registration (optional). Same handler tree the local
	// listener serves is muxed over a single outbound TCP connection to
	// the router — no extra goroutines per request, no exposed port.
	if strings.TrimSpace(*axRouterHost) != "" {
		rc, err := axrouter.NewHandler(axrouter.Config{
			ServerAddr: *axRouterHost,
			Token:      *axRouterToken,
			Service:    *axRouterName,
		}, srv.Handler())
		if err != nil {
			log.Error("ax-router init", "err", err)
		} else {
			log.Info("ax-router connecting",
				"host", *axRouterHost,
				"name", *axRouterName,
				"hasToken", *axRouterToken != "")
			wg.Add(1)
			go func() {
				defer wg.Done()
				if err := rc.Run(ctx); err != nil && !errors.Is(err, context.Canceled) {
					log.Error("ax-router", "err", err)
				}
			}()
		}
	}

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

