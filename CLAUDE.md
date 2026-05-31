# CLAUDE.md

Operational notes for Claude Code working in **discovery2** (the
`corp-module` branch) — a single-binary service-discovery server (Go) with
an embedded React UI, gossip-based clustering, **corp-ui-backed auth**,
and a per-service ACL model keyed by corp-ui user IDs. Read this once at
the start of a session; the per-file conventions below apply throughout.

This branch is a fork of `master` that swaps the local users / bcrypt /
sessions stack for corp-ui SSO. Users are not stored locally anymore;
permissions come from corp-ui's `is_admin` flag and the `perms` map.

**Capability map** (each has a section below; all replicate over the cluster):

- **Versioned discovery** — `Instance.Version` (semver) + npm-style constraint
  queries on `/discover` and `/pick` (`internal/semver`).
- **Balancing** — weighted `/pick`, plus **sticky-token affinity** (persisted +
  replicated, idle TTL, rebind on death).
- **Operator block** — `Instance.Blocked` kill-switch, survives re-register.
- **Observability** — node-local request stats (`/v1/stats`, dashboard) and an
  open, cluster-wide Prometheus `/metrics` (`internal/stats`).
- **Config store** — typed (`string/int/float/bool/json/bytes`), block-atomic
  versioned variables in `global / service / version` scopes (`internal/...config`).
- **Dynamic client tokens** — UI-minted read/write/admin bearer tokens.
- **Cluster hardening** — optional gossip encryption + reliable large-event send.
- **ax-router2 exposure** — opt-in reverse-router registration (off by default).

For the user-facing project description, see [`README.md`](README.md).
The companion Go client library is its own repo at
[`github.com/axgrid/discovery2-client`](https://github.com/axgrid/discovery2-client)
(local: `../discovery2-client`).

---

## Stack snapshot

- **Backend:** Go 1.25, `go.etcd.io/bbolt`, `hashicorp/memberlist`,
  `gorilla/websocket`, `Masterminds/semver/v3`, `golang.org/x/crypto/acme/autocert`,
  `joho/godotenv`, `google/uuid`, `axgrid/ax-router2/client`. Standard `net/http`
  (no chi/gin) — Go 1.22+ pattern matching. Vendored (`/vendor` gitignored;
  `make vendor` regenerates before a Docker/Kamal build).
- **Per-instance health modes:** `heartbeat` (default), `http`, `tcp`, `none`.
  Stored on `Instance.CheckMode` + `Instance.CheckIntervalSec`. Single
  ticker dispatches per mode (see `internal/health/health.go`). HTTP/TCP
  modes probe **all** matching interfaces (AND-semantics) and persist a
  per-interface report in `Instance.LastCheck`.
- **Frontend:** React 18 + Vite + TypeScript + **Tailwind v4** with the
  `@tailwindcss/vite` plugin. The **Ax Styler** design system is vendored
  under `src/components/ui/` (sources from `~/.claude/skills/ax-styler/source/`):
  Radix UI primitives, brand orange `#FF6B1A`, soft radii (10/14px), glass
  modals, sonner toasts. Theme via `data-theme="light|dark"` on `<html>`,
  applied inline before paint to avoid FOUC. Cookie-session auth via
  `credentials: "include"` on every fetch.
- **Storage:** single bbolt file. Buckets: `services`, `instances`, `sessions`,
  `affinity` (sticky tokens), `config` (variables/revisions/drafts),
  `client_tokens`, `audit`. No external DB. No local `users` bucket — users
  live in corp-ui.
- **Cluster:** memberlist gossip + HTTP `/cluster/snapshot` for anti-entropy;
  last-write-wins on `UpdatedAt`. Everything (services, instances, affinity,
  config, tokens) replicates the same way. Optional gossip encryption via
  `DISCOVERY_GOSSIP_SECRET`; events >1 KB sent reliably over TCP.

---

## Repo map (where things live)

```
cmd/discoveryd/main.go             # entrypoint; loads .env, builds corp.Client, optional ax-router registration, starts goroutines
internal/
├── model/types.go                 # all wire types: Service, Instance, Interface, Session,
│                                  # AuditEntry, Event, Visibility, Status; constants. NO local User type.
├── model/config.go                # config store types: VarType, TypedValue, ConfigScope, ConfigRevision, ConfigDraft
├── model/token.go                 # ClientToken (UI-minted s2s tokens)
├── store/                         # bbolt persistence + in-memory pub/sub (events fan-out)
│   ├── bolt.go                    # Open/Close, services + instances, Subscriber/emit, Snapshot, ApplyRemote, SetBlocked
│   ├── rename.go                  # RenameService (atomic move of service + all instances)
│   ├── sessions.go                # PutSession/GetSession/DeleteSession/SweepExpiredSessions (browser sessions only)
│   ├── affinity.go                # sticky-token bindings (PutAffinity/GetAffinity/Sweep), replicated
│   ├── config.go                  # config store: Apply/History/Rollback/Draft/Resolve, replicated
│   ├── tokens.go                  # dynamic client tokens (key=secret for O(1) auth), replicated
│   └── audit.go                   # AppendAudit/ListAudit (timestamp-keyed, reverse cursor)
├── semver/semver.go               # Masterminds/semver wrapper: Match/Valid/ValidConstraint (npm-style)
├── stats/stats.go                 # node-local lookup collector: per-service rps/sparkline, feed, clients
├── auth/
│   ├── auth.go                    # static-token Authenticator (s2s tokens, untouched)
│   └── identity.go                # Resolver: cookie OR static token OR iframe-JWT → Identity;
│                                  # corp.Client integration; RoleFromPerms; CanEditService
├── health/health.go               # TTL sweeper + optional active TCP/HTTP probes
├── cluster/cluster.go             # memberlist plumbing (optional SecretKey encryption), broadcast
│                                  # (TCP SendReliable for >1KB events), anti-entropy snapshots
└── server/
    ├── server.go                  # Run(), routes(), service/instance/discover/watch handlers, CORS, loginLimiter
    ├── discover_pick.go           # version-filtered discover, format=addr, weighted + sticky-token pick
    ├── config_handlers.go         # /v1/config/{resolve,scopes,scope,apply,draft,rollback,scope} (scope in body)
    ├── client_token_handlers.go   # /v1/client-tokens CRUD (write/admin; no role escalation)
    ├── observability_handlers.go  # block/unblock, GET /v1/stats, open Prometheus GET /metrics
    ├── hub.go                     # WebSocket fan-out for /v1/watch
    ├── auth_handlers.go           # /v1/auth/{login,logout,me}, /v1/corp/users/search,
    │                              # verify-password helper, requireAdmin, audit helper, safeStoreErr
    ├── grants_handlers.go         # /v1/services/{name}/grants (owner or admin), corp user IDs
    ├── audit_handlers.go          # /v1/audit (admin)
    └── *_test.go                  # uses static-token bearer for write tests; corp-ui path is integration-only

ui/
├── embed.go                       # //go:embed all:dist
├── dist/                          # built React assets (gitignored beyond placeholder)
└── web/
    ├── package.json, vite.config.ts (Tailwind plugin), tsconfig.json, public/
    └── src/
        ├── main.tsx               # ThemeProvider + I18nProvider + TooltipProvider + AuthProvider + Toaster
        ├── App.tsx                # routes; RequireAuth + RequireAdmin guards
        ├── index.css              # @import "tailwindcss" + tw-animate-css + ax-styler tokens
        ├── _ax-styler.css         # vendored tokens.css + tokens-theme.css + preflight.css
        ├── lib/
        │   ├── api.ts             # fetch wrapper (credentials: include); types; watch() WS reconnect
        │   └── auth.tsx           # AuthProvider, useAuth(); login/logout/refresh
        ├── lib/
        │   ├── corp.ts            # iframe detection, CorpSDK lazy-loader, theme sync
        │   └── …
        ├── components/
        │   ├── ui/                # vendored ax-styler — Button, Input, Card, Dialog, Select, Switch,
        │   │                      # Checkbox, Tabs, Tooltip, Avatar, ThemeToggle, theme.tsx, i18n.tsx, ...
        │   ├── AppShell.tsx       # sidebar w/ admin links + ThemeToggle (hides Sign Out in iframe mode)
        │   ├── Logo.tsx           # project-specific brand logo (orange gradient)
        │   └── StatusBadge.tsx    # thin wrapper over ax-styler Badge for instance up/down
        └── pages/                 # Login (standalone-only form + iframe fallback message),
                                   # Services, ServiceDetail (corp-user-search grants editor),
                                   # Cluster, Audit, About

.env.example                       # template for runtime config
Makefile                           # ui → go-build → cp bin/discoveryd ./discoveryd
```

---

## Build / run commands

```bash
make build         # full pipeline: npm install (sentinel) → vite build → go build → cp to ./discoveryd
make go-build      # Go binary only (assumes ui/dist exists)
make ui            # React build only
make run           # build + run on :8500
make run-cluster   # two-node local cluster (:8500 + :8501)
make test          # go test ./...
make clean         # bin, ui/dist, ui/web/node_modules, ./discoveryd

# UI dev server (proxies /v1 to :8500). Auth cookies still work because same-origin proxy.
cd ui/web && npm run dev
```

The binary lives at `./discoveryd` (project root) so it sits next to `.env`.
`./bin/discoveryd` is also produced for those who prefer it.

---

## Architecture invariants

### Identity & auth (corp-ui)

There is no local user store. Identities come from corp-ui via two
parallel paths, resolved by `auth.Resolver.Resolve(*http.Request)` in
this order:

1. **Cookie session** (`discovery_session`) — minted by our own
   `/v1/auth/login` after corp-ui's `POST /api/v1/auth/verify-password`
   accepted the credentials. The session row caches the corp-ui user's
   id/email/perms; **TTL is 15 min** (see `auth.SessionTTL`) — short
   enough that corp-ui group changes propagate without admin
   intervention.
2. **Bearer token** — tried first as a static service token
   (`DISCOVERY_*_TOKENS`); if no match, treated as an iframe JWT and
   introspected via `corp.Client.Introspect` (the SDK has a 30s
   per-token cache).
3. **Otherwise anonymous** with whatever role `AllowAnonymousRead` permits.

The corp-ui `perms` map is collapsed into the legacy `Role` enum by
`auth.RoleFromPerms(isAdmin, perms, permKey)`:

- `is_admin=true` OR `*:a` OR `<permKey>:a` → `RoleAdmin`
- `*:w` OR `<permKey>:w` → `RoleWrite`
- `*:r` OR `<permKey>:r` → `RoleRead`
- nothing → `RoleNone`

`permKey` defaults to `discovery` and is configurable via `CORP_PERM_KEY`.

Every `/v1` route is wrapped in `resolver.Middleware(auth.RoleNone, ...)` — that
attaches `Identity` to the context but does **not** itself reject anonymous
calls. Per-handler `requireRead` / `requireWrite` / `requireAdmin` enforce the
minimum role, and `auth.CanEditService(svc, identity)` enforces per-service ACL
on mutations.

ACL semantics:

- `Service.OwnerID` and `Service.Grants` hold **corp-ui user IDs** as
  stringified uints (e.g. `"42"`). Old UUIDs from pre-fork data will not
  match any current identity — that's intentional, services need
  re-owning after migration.
- **public** services — any authenticated identity can edit; system tokens always pass.
- **private** services — only `OwnerID`, admins, or users in `Grants` can edit.
- All services are readable & discoverable regardless of visibility.
- Grants management is stricter than edit: only owner or admin (see `canManageGrants`).

### corp-ui-specific landmines

- **`CORP_API_KEY` never leaves the backend.** The login form posts to
  our `/v1/auth/login`; we attach the API key server-side. Don't pass it
  through to the browser even "for convenience". The grants editor's
  user-search endpoint (`/v1/corp/users/search`) is admin-gated for the
  same reason — it would otherwise reveal corp-ui users to any
  authenticated discovery user.
- **Iframe vs cookie cohabitation.** Both can be present at the same
  time (cookie session + iframe Bearer). The resolver prefers the
  cookie because it carries our snapshot; the bearer is checked only
  when no cookie is present. The UI sets the Bearer **only** in iframe
  mode (`lib/corp.ts` + `lib/api.ts:setBearerToken`) so a standalone
  tab never accidentally falls through to the iframe path.
- **Login rate limit lives in the module.** corp-ui's verify-password
  does not lock out per-service; our `loginLimiter` (10/sec, burst 5,
  per-IP) is the only brake. Don't remove it. Failed logins also sleep
  150 ms to flatten timing oracles.
- **`/v1/auth/login` does not return a cookie token in JSON.** Only the
  `Set-Cookie` header. Don't try to bridge it to the iframe — iframe
  mode never uses the cookie (third-party cookies in iframes are
  unreliable in modern browsers).

### Tags

`Service.Tags` is a free-form `[]string` for grouping/filtering. The endpoints:

- `GET /v1/services?tag=foo` — list filtered by tag (exact match, AND-style across multiple `?tag=` would require a future change; currently only one is honoured).
- `GET /v1/tags` — `[{tag, count}]` of every distinct tag in use, alphabetically sorted (handler `listTags` in `server.go`).
- `GET /v1/discover?tag=foo` — every UP instance of every service carrying that tag (handler `discoverByTag`). Returns 400 if the query param is missing.

Tags ride along with the rest of the Service blob (gossip + anti-entropy carry them for free). The Go client mirrors all three: `ListServicesByTag`, `ListTags`, `DiscoverByTag`. `Registration.Tags` opportunistically merges into the parent service on `Register` (best-effort — a failed merge does not abort the instance write).

### Versions & semver discovery

`Instance.Version` is a free-form string; when it parses as semver it unlocks
constraint queries. `internal/semver` wraps `Masterminds/semver/v3` (npm-style:
`>=2.1.0`, `^2.1.0`, `~2.1.0`, `1.x`, `1.2.0 - 1.3.5`). Discovery endpoints take
`?version=<constraint>`; **instances with an empty/non-semver Version are
excluded when a constraint is present** (strict by design). Bad constraints →
400. `discover_pick.go` is the single source of the filter (`upInstances`),
which also drops blocked instances.

- `GET /v1/discover/{name}?version=…` — filtered instances (or `&format=addr[&iface=WEB]` for a flat `["host:port"]` list).
- `GET /v1/discover/{name}/pick?version=…&iface=…&token=…` — one instance (weighted, or sticky by token). Returns `{address,url,instance,sticky,rebound}`; 503 when none match.
- `GET /v1/instances` — every instance across all services (dashboard, avoids N+1).

### Sticky-token balancing (affinity)

`pick?token=<opaque>` pins a token to an instance so repeated calls land on the
same one until it idles past `DISCOVERY_AFFINITY_TTL` (default 20 min, sliding).
`model.Affinity` rows live in the `affinity` bbolt bucket (`store/affinity.go`),
**persist across restart and replicate cluster-wide** via `EventAffinityUpserted`
(gossip + `Snapshot.Affinity` + `ApplyRemote`, LWW on `UpdatedAt`). A pure idle
refresh writes locally **without emitting** (throttled to ~4/TTL) to avoid gossip
flood — only create/re-bind replicates (same stance as `SetLastCheck`). If the
pinned instance goes DOWN/blocked/away the next pick re-binds to a healthy one
(`rebound:true`). `runSweeper` in `main.go` evicts expired affinity + sessions.

### Operator block (kill-switch)

`Instance.Blocked` excludes an instance from discover/pick (traffic rebalances)
while it stays UP/heartbeating. It is **not** in the registration payload —
`store.PutInstance` preserves it across re-registers so a self-managed client
can't un-block itself. Toggle only via `POST /v1/services/{name}/instances/{id}/block`
(`store.SetBlocked`, bumps UpdatedAt → replicates); the handler uses
`allowInstanceWrite` (write+ACL) but skips `rejectManagedEdit`, so blocking works
on managed instances — it's an operator action. UI shows a Block/Unblock button.

### Observability (stats + metrics)

`internal/stats` is a **node-local** in-memory collector (not persisted/replicated):
per-service request counters + a 120s rps ring (sparkline), a recent-lookup feed,
and a per-client map. Lookups are recorded in the discover/pick handlers; the
caller is identified by `X-Discovery-Client` header → `?client=` → remote IP.
`GET /v1/stats` feeds the dashboard.

`GET /metrics` is Prometheus text format, **open (outside the `/v1` auth
pipeline)** and **cluster-wide** for health gauges (every node holds the full
replicated store): `discovery_up{service,version}` (materialised to 0 for any
(service,version) with no live instance — easy `==0` alarm), `discovery_instances{service,status}`,
`discovery_blocked{service}`, `discovery_requests_total{service,kind}` (node-local),
`discovery_cluster_nodes`.

### Config store (variables & settings)

A built-in KV/config store, replicated like everything else. Three **scopes**
(containers): `global`, `service:<name>`, `version:<name>:<constraint>` (semver,
same dialect as instance versions). Keys are flat with `/`-style prefixes
(etcd-like); the tree is just a UI view. Values are **typed** (`TypedValue{Type,
Value}`) — string/int/float/bool/json/bytes (bytes = base64), validated on write
(`model/config.go`, 1 MiB cap).

**Versioning is block-atomic with history.** Each scope is a versioned document:
`ApplyConfig` publishes the whole var set as a new `ConfigRevision` (allocates
`Revision = prev+1`, records history, clears draft). The **active** revision is
what clients read. `RollbackConfig(rev)` re-applies an old revision's vars as a
new revision (so rollback replicates like any apply). Optional per-scope
**draft** (`PutDraft`) holds unpublished edits. Storage keys in the `config`
bucket: `active/<scopeID>`, `rev/<scopeID>/<NNNN>`, `draft/<scopeID>` — scopeID
is `ConfigScope.ID()`, opaque (never parsed back; the scope is embedded in the
value).

**Resolution** (`ResolveConfig(service, version, prefixes, keys)`) merges
**global < service < version** into one flat map. Among matching version blocks
the higher constraint **floor** wins (`>=2.1.0` beats `>=2.0.0` for a 2.1.0
instance — `semver.Floor`). Returns provenance (which scope won each key). This
is the only resolve path; the client just reads the merged map.

**ACL** (`allowConfigWrite`): `global` → admin; `service`/`version` → service
ACL (`CanEditService`), falling back to any write-role when the service doesn't
exist yet — so config can be **pre-provisioned before a service registers**.

**Replication:** events `config.applied` (LWW: higher Revision, tie by
UpdatedAt), `config.draft.saved/deleted`, `config.deleted`; anti-entropy
snapshot carries all revisions + drafts. `applyConfigRemote` stores the revision
in history and advances active when newer (`putConfigRevisionRaw`).

### Dynamic client tokens

Runtime-minted s2s bearer tokens (`model/token.go`, `store/tokens.go`),
complementing the static `DISCOVERY_*_TOKENS` env tokens. Stored **in the clear**
(an operator choice — re-displayable/copyable in the UI; pair with
`DISCOVERY_GOSSIP_SECRET`) keyed by the secret itself for O(1) auth lookup. The
resolver checks them in `identity.go` **after** static env tokens, **before**
the iframe JWT path; a hit yields `Identity{System:true, Role}`.

Endpoints (`/v1/client-tokens`) are gated by `requireWrite` — **read-only callers
can't even list tokens** — and you **cannot mint a token with a role above your
own** (no privilege escalation). Tokens are non-expiring; revoke by ID. Secret
format: `dsc_<base64url(24 random bytes)>`. Replicated via `token.upserted` /
`token.deleted` (LWW on UpdatedAt) + snapshot.

### Managed instances

`Instance.Managed bool` marks an instance as self-registered by a client
library (the discovery2-client `Register` call always sets it to `true`).
The server protects such instances from accidental UI edits:

- A user holding a **cookie session** that PUTs or DELETEs a managed
  instance is rejected with `409 Conflict`. See
  `(*Server).rejectManagedEdit` in `server.go`.
- A **system identity** (static bearer token) bypasses the check — that's
  the path the owning client takes when it re-registers, and also the
  admin override.

UI surfaces the flag via a "self-managed" badge with a lock icon; the
Edit and Delete buttons are hidden for managed instances. The Copy
button stays — copying produces a fresh draft with `managed=false`,
which the operator can then save as a normal editable instance.

`POST` (register) does **not** consult the flag — only PUT/DELETE on an
existing managed instance is gated. New registrations are always allowed.

### Audit

Every mutation goes through `s.audit(r, action, target, targetType, details)`,
which reads `Identity` from context and appends to the `audit` bucket. The one
exception is **login**, which audits with the just-authenticated user (the
context still holds the pre-login anonymous identity at that point — see the
explicit `s.store.AppendAudit` call in `auth_handlers.go`).

Audit entries are keyed by `unix-nano + "/" + uuid` so reverse-cursor iteration
returns the newest first. Add new action constants in `model/types.go` next to
`AuditServiceCreated` etc.

### Store + events

`store.Store` owns the bbolt file and an in-memory subscriber list. Mutations
emit `model.Event` to all subscribers (the WebSocket hub and the gossip cluster).
The cluster broadcasts events to peers and ignores its own echoes via `OriginID`.

`ApplyRemote` is the cluster-side merge — it implements last-write-wins by
comparing `UpdatedAt`. Don't bypass it for cross-node updates.

### Cluster

`memberlist` for membership + best-effort small-event broadcast. New nodes pull
a full HTTP snapshot from one peer; every 30 s they re-pull from a random peer
(anti-entropy). Service ACL fields (`OwnerID`, `Grants`, `Visibility`) ride on
the same JSON-encoded `Service` blobs, so they replicate for free.

**Hardening (opt-in).** `DISCOVERY_GOSSIP_SECRET` (base64 of 16/24/32 bytes →
`memberlist.SecretKey`) encrypts + authenticates all gossip; a wrong/absent key
is rejected at join. A malformed key is a hard startup error (no silent plaintext
fallback). `DISCOVERY_CLUSTER_TOKEN` gates `/cluster/snapshot`. When `-seeds` is
set but either is empty, `main.go` logs a loud WARN. `broadcastEvent` sends
events >1 KB via `SendReliable` (TCP) instead of the UDP gossip queue, which
silently drops oversized broadcasts — small events still use the cheap queue,
anti-entropy backstops both.

### Health

`internal/health` runs **one** ticker (every 5 s) that walks all instances
and dispatches per `Instance.CheckMode`:

- `heartbeat` (default when unset) — TTL check; flip to `down` if
  `LastHeartbeat` older than `TTLSeconds`. The instance is responsible for
  recovery (sending a heartbeat) — health never flips it back to `up` on its
  own.
- `http` — probe **every** HTTP/HTTPS/WS/WSS interface. **All must pass**
  for the instance to be `up`. Per interface: use `HealthURL` first
  (full URL allowed for proxy-fronted services); else `Path`; else `/`,
  any 2xx-3xx counted as up. `CheckIntervalSec` (default 15 s) controls cadence.
- `tcp` — TCP connect to **every** interface's port. All must succeed.
- `none` — health never auto-changes status.

URL building lives in `buildProbeURL` (single source of truth). It strips
the port when it's the scheme default (0 / 80 / 443) so proxy-fronted
services like `https://name.example.com` get a clean URL.

Per-probe results land in `Instance.LastCheck` (`InstanceCheck` with
per-interface `[]ProbeResult`). The UI uses `LastCheck` to colour
interface pills (red when that interface failed). `LastCheck` is written
by `store.SetLastCheck` which intentionally **does not emit an event** —
each tick × instance × node would otherwise flood the gossip channel.
Updates reach the UI via the next status flip event or a page refresh.

There is **no** global "active probes" flag anymore — probing is per-instance,
configured at registration. If you need a server-wide default, add it as a
field on the daemon config and stamp new instances with it.

**Heartbeat recovery semantics.** `store.Heartbeat` lifts `Down → Up` when
the caller passes an empty status. This is the recovery path after a
network blip / laptop sleep / anything that lets the TTL sweeper mark an
instance Down. Without the lift, the instance stayed red forever even
though its client kept heartbeating (the auto-heartbeat goroutine in
discovery2-client always sends `""` as status). `Draining` and `Starting`
are preserved on empty heartbeats — they're explicit operator/client
choices and a heartbeat shouldn't undo them.

The client also fires one heartbeat **immediately** at the start of the
loop (not after the first ticker interval) so wake-from-sleep recovery
takes ≤ one network RTT instead of TTL/3 seconds. Don't revert that.

### Automatic HTTPS (autocert)

`server.Run` branches on `Config.TLS.Enable`. When on, `runTLS` starts two
listeners:

- **:443 (HTTPS)** with `m.TLSConfig()` from `autocert.Manager`. Certificates
  are fetched on demand and cached in `TLS.CacheDir` (default `./certs`).
- **:80 (HTTP)** running `m.HTTPHandler(http.HandlerFunc(redirectToHTTPS))` —
  serves the ACME `http-01` challenge and redirects everything else to HTTPS.

`autocert.HostPolicy` is **mandatory** (`HostWhitelist(Domains...)`); without
a domain allow-list autocert refuses to start, which is the behaviour we
want — otherwise the server can be abused as an ACME proxy.

Staging mode (`TLS.Staging`) swaps in Let's Encrypt's staging ACME directory
via `acme.Client{DirectoryURL: ...}`; certs are untrusted but issuance is
unconstrained, useful for dry-running deploys.

The cluster's gossip / anti-entropy code is unaware of TLS — peers still talk
HTTP between each other on the cluster port. If you need cross-node TLS for
gossip itself, that's a much bigger lift (memberlist's encryption is symmetric
key, not TLS).

### On-demand health check

`POST /v1/services/{name}/instances/{id}/check` runs the probe synchronously
and returns the per-interface report (`{"ok":..., "status":"down", "mode":"http", "results":[...]}`).
The handler also persists the result via `SetLastCheck` and flips status if
needed. Used by the UI's "Check" button on each instance card.

### ax-router2 exposure (opt-in)

`cmd/discoveryd/main.go` can register the **whole discovery handler tree**
(`srv.Handler()`) with an `ax-router2` reverse router in **handler mode** —
making the API reachable at `https://<AX_ROUTER_NAME>.<router-base>` without
opening the service port. It's muxed over one outbound TCP connection (no extra
per-request goroutines, no inbound port).

**It is off by default and gated by `AX_ROUTER_ENABLE` (`-ax-router`).** Setting
only `AX_ROUTER_HOST` no longer starts it — the explicit boolean must be true.
The reason is local clusters: every node reads the same `.env`, and ax-router is
last-writer-wins per service name, so two nodes registering as `discovery` would
kick each other off. `make run-cluster` passes `-ax-router=false` on every node;
enable the router on a single node via `make run-router`. When enabled with an
empty `AX_ROUTER_HOST`, startup fails fast rather than silently no-op'ing.

---

## Landmines

These have bitten us; future code touching adjacent areas should be careful.

1. **`model.User.PasswordHash` JSON tag.** Must be `json:"passwordHash,omitempty"`,
   not `json:"-"`. The User row is persisted by `json.Marshal`-ing into bbolt,
   so `json:"-"` silently drops the hash on save and login fails. Handlers
   explicitly redact it before returning to clients (`u.PasswordHash = ""`).
   If you add another secret-bearing field, copy that pattern — don't reach
   for `json:"-"`.

2. **macOS Sequoia + Go before 1.22.5** produces binaries missing `LC_UUID`
   that dyld refuses to load. We're past it on 1.23.4, but if anyone downgrades
   the toolchain in `go.mod`, expect "missing LC_UUID" and add
   `-ldflags='-linkmode=external'` until they upgrade back.

   *Related, distinct issue:* Go's "linker-signed" ad-hoc signature
   (`flags=0x20002`) is killed on launch by macOS Sequoia (exit 137,
   silently, no log) for binaries that embed large data sections — i.e.
   anything using `embed.FS` to bundle a React build. The Makefile re-signs
   with `codesign -s -` after `go build`, converting it to a plain ad-hoc
   signature that Sequoia accepts. If you add a new Go binary to this repo
   (e.g. another `cmd/...`), copy that codesign step in the Makefile.

3. **Gossip echo loops.** Events have `OriginID`. The cluster broadcaster sets
   it to its own node ID before sending; the receiver drops events whose
   `OriginID` equals its own node ID. `ApplyRemote` also uses `OriginID:
   "snapshot"` for anti-entropy bootstraps so they don't get re-broadcast.
   Don't strip or rewrite `OriginID` casually.

4. **CORS + cookies.** `withCORS` echoes the request `Origin` (not `*`) and
   sets `Access-Control-Allow-Credentials: true`, because browsers refuse
   credentialed requests to wildcard origins. The UI dev proxy (`vite`) hides
   this in dev; CORS only matters for cross-origin tools.

5. **Service auto-stub on instance write.** `PutInstance` creates a stub
   `Service` if none exists — that stub has no owner, so any authenticated user
   can edit it. This is intentional: services-registering-themselves via a
   static token shouldn't require a separate "create the service" API call.
   Don't change the stub flow without considering the registration UX.

6. **Empty-string time fields kill JSON decode.** `time.Time` cannot decode
   from `""` — only `null` or a valid RFC3339 string. Browser code spreading
   a server-provided `Instance` back into a PUT body would send
   `lastHeartbeat: ""` etc. and break everything. **Don't decode raw
   `model.Service` / `model.Instance` from request bodies** — use the
   `serviceInput` / `instanceInput` DTOs in `server.go` and copy into the
   model after. Mirror that on the UI: never spread `Service`/`Instance`
   into a PUT payload, build a fresh object with only writable fields
   (see how `ServiceInput` / `InstanceInput` are defined in `lib/api.ts`).

7. **Service rename moves instances atomically.** `RenameService` (in
   `store/rename.go`) does the move in a single bbolt transaction so a
   peer pulling a snapshot mid-rename sees the old or new name, never
   half-and-half. The rename emits one delete + one upsert + per-instance
   upsert events; the cluster propagates these via the normal gossip path.
   Don't add a "fast path" that skips the events — peers would diverge.

8. **macOS Sequoia kills `linker-signed` binaries with embedded data.**
   Go's linker emits an "ad-hoc linker-signed" signature
   (`flags=0x20002`); Sequoia silently SIGKILLs binaries with this
   signature when they embed large blobs (our React UI). The Makefile
   re-signs each binary with `codesign -s -` after build, converting it
   to a plain ad-hoc signature (`flags=0x2`) that Sequoia accepts. If you
   add another `cmd/...` binary, add its codesign line too.

9. **`SetLastCheck` does not emit events on purpose.** The background
   probe ticks every 5 s × every instance × every node — emitting events
   on every tick would multiply traffic (gossip + WS) for ~zero user
   benefit. Status *flips* still emit `InstanceStatus` events with the
   updated payload (which carries the latest `LastCheck`), so peers and UI
   stay in sync at decision points. If you need live per-tick updates in
   the UI, the right path is the on-demand `/check` endpoint (which the
   UI's Check button uses), not making the background probe noisier.

---

## How to extend

### Add a new REST endpoint

1. Pick the handler file (`server.go` for general, `users_handlers.go` for users, etc.). Create a new `*_handlers.go` if it's a new resource.
2. Register the route in `server.routes()` on the `api` mux. Use Go 1.22 method+path syntax: `api.HandleFunc("POST /v1/foo", s.fooHandler)`.
3. Inside the handler, call `requireRead` / `requireWrite` / `requireAdmin` first, then any per-resource ACL check (`auth.CanEditService` for services).
4. Emit an audit entry via `s.audit(r, "...", target, targetType, details)`.
5. Return errors via `safeStoreErr` so `ErrNotFound` / `ErrConflict` map to 404/409.

### Add a new audit action

1. Add the constant in `internal/model/types.go` (e.g. `AuditFooBarred = "foo.barred"`).
2. Call `s.audit(r, model.AuditFooBarred, target, targetType, details)` from the handler.
3. The UI's `Audit.tsx` colours actions automatically by substring match
   (`deleted` → red, `created`/`upserted` → green, `login`/`logout` → brand);
   pick a name that fits one of those buckets, or extend `ActionBadge`.

### Add a new field to Service / Instance

1. Add it to `model.Service` (or `model.Instance`) with a `json:"..."` tag.
   Don't touch `CanEdit` unless the new field affects ACL.
2. **If the field is user-editable**, also add it to the corresponding input
   DTO in `internal/server/server.go` (`serviceInput` / `instanceInput`) and
   propagate it in the `toModel` / handler-side construction.
3. If it's user-visible, surface it in the UI: types in `lib/api.ts` (both
   the response shape AND the `*Input` types), then the relevant page.
4. **Persistence is automatic** — bbolt rows are JSON-encoded, so new fields
   just appear. Old rows decode with the field at zero value.
5. **Replication is automatic** — blobs are passed through `Event.Payload`
   end-to-end; gossip / anti-entropy carry it without changes.

### Add a new UI page

1. Create `ui/web/src/pages/Foo.tsx`.
2. Add a route in `App.tsx` inside the `<RequireAuth>` (or `<RequireAdmin>` for admin-only) group.
3. Add a nav link in `components/AppShell.tsx`. Admin-only links go inside the `me?.isAdmin && (...)` block.
4. Use ax-styler primitives from `@/components/ui` — `Card` / `CardContent`, `Button` (variants: `primary` / `secondary` / `ghost` / `outline` / `danger` / `link`), `Input`, `Label`, `Select` + `SelectTrigger` / `SelectContent` / `SelectItem`, `Dialog` + `DialogContent` / `DialogHeader` / `DialogTitle` / `DialogFooter`, `Badge` (variants: `brand` / `success` / `warning` / `danger` / `info` / `neutral` / `outline`), `Switch`, `Checkbox`. For confirmations use a `Dialog` with two buttons (don't `confirm()`); for transient messages, `toast.success()` / `toast.error()` from `sonner`. Don't reach for raw Tailwind colour utilities — use the ax-styler tokens (`bg-bg`, `text-fg`, `text-fg-muted`, `border-border`, `bg-surface`, etc.).

### Add a new env var

1. Add a flag with `envOr/envIntOr/envBoolOr` default in `cmd/discoveryd/main.go`.
2. Document it in `.env.example` with a short comment block.
3. Add a row to the README config table.

### Add a runtime cluster operation

`internal/cluster/cluster.go` exports a small surface (`Members`, `Join`,
`Shutdown`) intended to be called from admin handlers. New runtime ops
should:

1. Live as a method on `*Cluster` so the memberlist instance stays
   encapsulated.
2. Get an admin-gated handler in `internal/server/server.go` (see
   `clusterJoin` for the pattern).
3. Audit via `s.audit(r, action, "cluster", "cluster", details)`. Cluster
   events are not part of the gossip-replicated state, so they only show up
   in the local audit log of the node that received the request.

---

## UI invariants (ax-styler hard rules)

These are baked-in. Drop them and the design system breaks.

1. **Theme** is `data-theme="light"|"dark"` on `<html>`, persisted to
   `localStorage['ax-styler-theme']`, applied inline before paint
   (`<script>` in `index.html`). **Never** rely on `prefers-color-scheme`
   alone or use `class="dark"` (Tailwind v4 doesn't honour our setup).
2. **Inputs** carry their border on the **outer wrapper**; the inner native
   `<input>` is `border-0 bg-transparent`. Don't add a second border to the
   inner element — you'll get double-borders in dark mode.
3. **No global** `:focus-visible { box-shadow: ring }`. Each component draws
   its own focus ring on its outer wrapper. Adding a global ring causes
   double-rings on inputs / selects / etc.
4. **Radius** always via `var(--radius-*)` (or the corresponding utility
   `rounded-[var(--radius-md)]`). Never hardcoded `rounded-md`
   (Tailwind default is 6px; ours is 10px) or raw rems.
5. **Toasts**: `<Toaster />` is mounted once in `main.tsx`; toasts go
   top-right. Don't add per-page toasters.
6. **Modals**: use `Dialog` from `@/components/ui` — never inline
   `<div className="fixed inset-0...">`. `Dialog` ships with the glass
   backdrop + focus trap + Escape handling.
7. **`react-day-picker`**: never `import 'react-day-picker/style.css'` — it
   ships unlayered rules that win over Tailwind utilities and break
   dark-mode range styling. The vendored `Calendar` component handles all
   styling.

## Code style

- `slog` everywhere. Pass `*slog.Logger` via `Config.Logger`; default to `slog.Default()`.
- Errors carry context via `fmt.Errorf("%s: %w", op, err)`. `errors.Is` for sentinels (`store.ErrNotFound`, `store.ErrConflict`).
- No third-party HTTP router. Routes use Go 1.22's `mux.HandleFunc("METHOD /path/{param}", h)` pattern.
- Tests use `httptest.NewServer` + the static-token bearer — see `internal/server/server_test.go` for the template.
- Don't add comments that restate the code. Comments explain a non-obvious *why*: a hidden invariant, a workaround, a constraint. The audit-on-login workaround in `auth_handlers.go` is the canonical example.

---

## Two-repo discipline

The Go client library is **not** a sibling package in this module. It's a
separate Go module at `github.com/axgrid/discovery2-client`. When wire types
change in `internal/model/types.go`, the corresponding fields must be updated
in `discovery2-client/types.go` as well — these are duplicated on purpose so
the client doesn't import server internals.

If a wire change is non-trivial, prefer additive-only changes for one release
to give the client time to catch up.

There's a Claude Code skill (`/ax-discovery2-client`, at
`~/.claude/skills/ax-discovery2-client/SKILL.md`) for wiring the client into a
user's Go app — invoke it rather than re-deriving the integration each time.
The skill asks the user a few questions (register / resolve / both, liveness
mode, config source) before scaffolding.
