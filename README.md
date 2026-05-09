# discovery2

Service-discovery server with a built-in React UI, gossip-based clustering,
login/password auth, per-service ACL, and an audit trail. Single self-contained
Go binary — no external database.

The companion Go client library is its own repository:
[github.com/axgrid/discovery2-client](https://github.com/axgrid/discovery2-client).

![discovery services page](docs/screenshots/services.png)

## Features

- **Services + instances.** Register a logical service, attach one or more
  running instances, describe the network interfaces each instance exposes
  (`WEB`, `WS`, `TCP:4000`, `GRPC`, …).
- **Per-instance health modes.** `heartbeat` (the default — the service pings
  discovery), `http` / `tcp` (discovery actively probes the instance), or
  `none` (no auto-status). HTTP/TCP modes probe **every** matching interface
  and require **all** to pass — multi-interface instances fail health if any
  one of them does. The latest probe report is persisted on the instance and
  surfaced in the UI: failed interfaces appear red.
- **On-demand check.** Each instance has a **Check** button that runs a probe
  synchronously and shows the per-interface result (URL, HTTP status, latency,
  error). Useful for debugging registrations.
- **Multi-address balancing.** The Go client library picks healthy instances
  via `RoundRobin` (default), `Random`, or `Weighted` strategies, and
  refreshes its view live over WebSocket.
- **Fault-tolerant cluster.** Nodes find each other via gossip
  (`hashicorp/memberlist`), broadcast change events, and reconcile via
  periodic anti-entropy snapshots. Last-write-wins on `UpdatedAt`. Peers can
  be added at runtime from the UI by an admin.
- **Login + per-service ACL.** Cookie-session auth for the UI, static API
  tokens for service-to-service traffic. Services are `public` (any
  authenticated user can edit) or `private` (only owner / admin / explicitly-
  granted users can edit). Discovery is unrestricted regardless of visibility.
- **Audit log.** Every mutation (service / instance / user / grant / login /
  cluster join) is recorded with actor, target, and a details blob; admins
  browse it in the UI with filtering by service.
- **Storage:** embedded BoltDB, single file. UI is embedded into the binary.
- **REST API + WebSocket** for change events.
- **Light / dark theme**, embedded SVG favicon, PWA manifest.

## Screenshots

| Services list | Service detail with health pills |
|---|---|
| ![](docs/screenshots/services.png) | ![](docs/screenshots/service-detail.png) |

| Instance editor (liveness mode + per-interface health URL) | Audit log |
|---|---|
| ![](docs/screenshots/instance-editor.png) | ![](docs/screenshots/audit.png) |

| Users (admin) | Cluster + runtime peer join |
|---|---|
| ![](docs/screenshots/users.png) | ![](docs/screenshots/cluster.png) |

(See [`docs/screenshots/README.md`](docs/screenshots/README.md) for the
expected file names if you want to refresh them.)

## Quick start

```bash
cp .env.example .env       # adjust DISCOVERY_DEFAULT_ADMIN_PASSWORD at minimum
make build                 # builds UI + binary; output at ./discoveryd
./discoveryd
```

Open <http://localhost:8500> and sign in with the credentials from `.env`.
On first launch, if no users exist, an admin is auto-created from
`DISCOVERY_DEFAULT_ADMIN_USER` / `DISCOVERY_DEFAULT_ADMIN_PASSWORD`.

### Two-node cluster (one machine)

```bash
make run-cluster
```

Both UIs (`:8500`, `:8501`) show the same data.

### Configuration

All flags also accept env vars (`DISCOVERY_*`). See `.env.example`.

| Flag | Env | Default | |
|---|---|---|---|
| `-listen` | `DISCOVERY_LISTEN` | `:8500` | API + UI bind |
| `-db` | `DISCOVERY_DB` | `./discovery.db` | bbolt file |
| `-node-id` | `DISCOVERY_NODE_ID` | hostname | gossip node name |
| `-gossip-bind` / `-gossip-port` | `DISCOVERY_GOSSIP_*` | `0.0.0.0` / `7946` | |
| `-advertise-ip` | `DISCOVERY_ADVERTISE_IP` | auto | gossip advertise |
| `-advertise-api` | `DISCOVERY_ADVERTISE_API` | `127.0.0.1:<port>` | host:port peers should use to reach our HTTP API |
| `-seeds` | `DISCOVERY_SEEDS` | (none) | comma-separated `host:port` |
| `-cluster-token` | `DISCOVERY_CLUSTER_TOKEN` | (none) | shared secret for `/cluster/*` |
| `-read-tokens` / `-write-tokens` / `-admin-tokens` | `DISCOVERY_*_TOKENS` | (none) | comma-separated |
| `-allow-anonymous-read` | `DISCOVERY_ALLOW_ANON_READ` | `true` | |
| `-default-admin-user` | `DISCOVERY_DEFAULT_ADMIN_USER` | `admin` | Bootstrap admin username (only created if no users exist) |
| `-default-admin-password` | `DISCOVERY_DEFAULT_ADMIN_PASSWORD` | `admin` | Bootstrap admin password |

Liveness checks are configured **per instance** (`CheckMode` field), not via
a server-wide flag.

## REST API

```
# Auth (cookie session)
POST   /v1/auth/login           # body: {"username":"...","password":"..."}
POST   /v1/auth/logout
GET    /v1/auth/me

# Services & instances (writes require write access; private services check ACL)
GET    /v1/services
PUT    /v1/services/{name}                          # ACL-checked
GET    /v1/services/{name}
DELETE /v1/services/{name}                          # ACL-checked, cascades
POST   /v1/services/{name}/rename                   # body: {"newName":"..."}; ACL-checked

GET    /v1/services/{name}/instances
POST   /v1/services/{name}/instances
PUT    /v1/services/{name}/instances/{id}
GET    /v1/services/{name}/instances/{id}
DELETE /v1/services/{name}/instances/{id}
POST   /v1/services/{name}/instances/{id}/heartbeat # body: {"status":"up"}
POST   /v1/services/{name}/instances/{id}/check     # synchronous probe; per-interface report

# Grants (owner or admin only)
POST   /v1/services/{name}/grants                   # body: {"userId":"..."}
DELETE /v1/services/{name}/grants/{userId}

# Discovery & cluster
GET    /v1/discover/{name}                          # only "up" instances
GET    /v1/cluster/members
POST   /v1/cluster/join                             # admin; body: {"seeds":["host:port", ...]}
GET    /v1/health
GET    /v1/watch                                    # WebSocket → DiscoveryEvent

# Users & audit (admin only)
GET    /v1/users
POST   /v1/users
PUT    /v1/users/{id}
DELETE /v1/users/{id}
GET    /v1/audit?limit=N&service=NAME
```

**Auth** for UI calls: cookie session (`discovery_session`). For
service-to-service traffic, static tokens still work via
`Authorization: Bearer <token>` / `X-API-Token` / `?token=` — they identify
as `system` and bypass ACL on services.

## Go client

Use the separate [discovery2-client](https://github.com/axgrid/discovery2-client) module:

```bash
go get github.com/axgrid/discovery2-client
```

```go
import discovery "github.com/axgrid/discovery2-client"

d := discovery.New("http://disc1:8500,http://disc2:8500",
    discovery.WithToken("write-token"))

reg, _ := d.Register(ctx, discovery.Registration{
    Service: "billing",
    Address: "10.0.0.5",
    Interfaces: []discovery.Interface{
        {Name: "WEB",  Protocol: "http", Port: 8080, HealthURL: "/healthz"},
        {Name: "GRPC", Protocol: "tcp",  Port: 9000},
    },
    TTLSeconds: 30,

    // Optional: hand liveness over to the server. Default is heartbeat.
    // CheckMode: discovery.CheckHTTP,
    // CheckIntervalSec: 15,
})
defer reg.Close()

res, _ := d.NewResolver(ctx, "billing", discovery.RoundRobin)
addr, _ := res.PickAddress("WEB")   // "10.0.0.5:8080"
```

Strategies: `RoundRobin`, `Random`, `Weighted`.

If you use Claude Code, the **`/discovery2-client`** skill wires it up for you.

## Development

```bash
# Backend tests
make test

# UI dev server (proxies /v1 to localhost:8500)
cd ui/web && npm run dev
```

For maintainers and AI assistants: see [`CLAUDE.md`](CLAUDE.md) for
architecture notes, invariants, and known landmines (macOS codesigning,
JSON-time decoding, gossip echo loops, etc.).
