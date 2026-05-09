# CLAUDE.md

Operational notes for Claude Code working in **discovery2** — a single-binary
service-discovery server (Go) with an embedded React UI, gossip-based
clustering, login/password auth, and a per-service ACL model. Read this once
at the start of a session; the per-file conventions below apply throughout.

For the user-facing project description, see [`README.md`](README.md).
The companion Go client library is its own repo at
[`github.com/axgrid/discovery2-client`](https://github.com/axgrid/discovery2-client)
(local: `../discovery2-client`).

---

## Stack snapshot

- **Backend:** Go 1.23 (toolchain 1.23.4), `go.etcd.io/bbolt`, `hashicorp/memberlist`,
  `gorilla/websocket`, `golang.org/x/crypto/bcrypt`, `joho/godotenv`,
  `google/uuid`. Standard `net/http` (no chi/gin) — Go 1.22+ pattern matching.
- **Per-instance health modes:** `heartbeat` (default), `http`, `tcp`, `none`.
  Stored on `Instance.CheckMode` + `Instance.CheckIntervalSec`. Single
  ticker dispatches per mode (see `internal/health/health.go`). HTTP/TCP
  modes probe **all** matching interfaces (AND-semantics) and persist a
  per-interface report in `Instance.LastCheck`.
- **Frontend:** React 18 + Vite + TypeScript + Tailwind 3, react-router-dom v6.
  No state library; React context for `auth` and `theme`. Cookie-session auth
  via `credentials: "include"` on every fetch.
- **Storage:** single bbolt file. Buckets: `services`, `instances`, `users`,
  `users_by_name`, `sessions`, `audit`. No external DB.
- **Cluster:** memberlist gossip + HTTP `/cluster/snapshot` for anti-entropy;
  last-write-wins on `UpdatedAt`.

---

## Repo map (where things live)

```
cmd/discoveryd/main.go             # entrypoint; loads .env, bootstraps default admin, starts goroutines
internal/
├── model/types.go                 # all wire types: Service, Instance, Interface, User,
│                                  # Session, AuditEntry, Event, Visibility, Status; constants
├── store/                         # bbolt persistence + in-memory pub/sub (events fan-out)
│   ├── bolt.go                    # Open/Close, services + instances, Subscriber/emit, Snapshot, ApplyRemote
│   ├── rename.go                  # RenameService (atomic move of service + all instances)
│   ├── users.go                   # PutUser/GetUser/GetUserByUsername/ListUsers/DeleteUser/CountUsers
│   ├── sessions.go                # PutSession/GetSession/DeleteSession/SweepExpiredSessions
│   └── audit.go                   # AppendAudit/ListAudit (timestamp-keyed, reverse cursor)
├── auth/
│   ├── auth.go                    # static-token Authenticator (legacy, kept for service-to-service)
│   └── identity.go                # Resolver: cookie OR token → Identity; bcrypt + session helpers; CanEditService
├── health/health.go               # TTL sweeper + optional active TCP/HTTP probes
├── cluster/cluster.go             # memberlist plumbing, broadcast, anti-entropy snapshots
└── server/
    ├── server.go                  # Run(), routes(), service/instance/discover/watch handlers, CORS
    ├── hub.go                     # WebSocket fan-out for /v1/watch
    ├── auth_handlers.go           # /v1/auth/{login,logout,me} + s.audit() helper + safeStoreErr
    ├── users_handlers.go          # /v1/users CRUD (admin)
    ├── grants_handlers.go         # /v1/services/{name}/grants (owner or admin)
    ├── audit_handlers.go          # /v1/audit (admin)
    └── *_test.go                  # uses static-token bearer for write tests; resolver path covers both auths

ui/
├── embed.go                       # //go:embed all:dist
├── dist/                          # built React assets (gitignored beyond placeholder)
└── web/
    ├── package.json, vite.config.ts, tailwind.config.js
    └── src/
        ├── main.tsx               # ThemeProvider + AuthProvider wrap App
        ├── App.tsx                # routes; RequireAuth + RequireAdmin guards
        ├── lib/
        │   ├── api.ts             # fetch wrapper (credentials: include); types; watch() WS reconnect
        │   ├── auth.tsx           # AuthProvider, useAuth(); login/logout/refresh
        │   └── theme.tsx          # light/dark toggle; class="dark" + data-theme
        ├── components/            # AppShell (sidebar w/ admin links), ThemeToggle, Logo, StatusBadge
        └── pages/                 # Login, Services, ServiceDetail (incl. visibility+grants editor),
                                   # Cluster, Users, Audit, About

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

### Identity & auth

Two parallel auth modes, resolved by `auth.Resolver.Resolve(*http.Request)`:

1. **Cookie session** (`discovery_session`) → looks up user → `Identity{UserID, IsAdmin, Role}`.
2. **Static token** (`Authorization: Bearer <token>` or `X-API-Token` or `?token=`) → `Identity{System: true, Role: ...}`.
3. **Otherwise anonymous** with whatever role `AllowAnonymousRead` permits (default `RoleRead`).

Every `/v1` route is wrapped in `resolver.Middleware(auth.RoleNone, ...)` — that
attaches `Identity` to the context but does **not** itself reject anonymous
calls. Per-handler `requireRead` / `requireWrite` / `requireAdmin` enforce the
minimum role, and `auth.CanEditService(svc, identity)` enforces per-service ACL
on mutations.

ACL semantics (matches the user spec):

- **public** services — any authenticated identity can edit; system tokens always pass.
- **private** services — only `OwnerID`, admins, or users in `Grants` can edit.
- All services are readable & discoverable regardless of visibility.
- Grants management is stricter than edit: only owner or admin (see `canManageGrants`).

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

### On-demand health check

`POST /v1/services/{name}/instances/{id}/check` runs the probe synchronously
and returns the per-interface report (`{"ok":..., "status":"down", "mode":"http", "results":[...]}`).
The handler also persists the result via `SetLastCheck` and flips status if
needed. Used by the UI's "Check" button on each instance card.

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
4. Use the existing component classes: `card`, `btn-primary` / `btn-secondary` / `btn-ghost` / `btn-danger`, `input`, `label`, `badge`, `badge-brand`, `badge-success`, `badge-warn`, `badge-danger`, `kbd`. Don't introduce new ones for one-off pages — the visual language is shared with cashier-ui.

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

There's a Claude Code skill (`/discovery2-client`, at
`~/.claude/skills/discovery2-client/SKILL.md`) for wiring the client into a
user's Go app — invoke it rather than re-deriving the integration each time.
