# syntax=docker/dockerfile:1.7
#
# Multi-stage build for discovery2.
#
#   1. ui    — node 22 builds the React UI bundle into ui/dist
#   2. build — go 1.25 compiles a static binary with -mod=vendor so the
#              local replace directive for corp-ui SDK works in Docker.
#              vendor/ is committed, so a clean checkout builds as-is. If you
#              change deps, run `make vendor` and commit the vendor/ delta
#              (a stale tree fails with "package … not in vendor directory"
#              or a go.mod/modules.txt mismatch).
#   3. run   — minimal Alpine image. ca-certificates so the binary can
#              hit corp-ui over HTTPS; tini so SIGTERM reaches the Go
#              process and bbolt closes cleanly. Non-root user 10001.

# ---------- 1. UI ----------
# Vite is configured with outDir="../dist", i.e. one level above the
# web/ working directory. We mirror that — /ui/web is WORKDIR for the
# build, /ui/dist is the output the Go stage reads from.
FROM node:22-alpine AS ui
WORKDIR /ui/web
COPY ui/web/package.json ui/web/package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --fund=false
COPY ui/web/ ./
RUN npm run build && ls -la ../dist


# ---------- 2. Go build ----------
FROM golang:1.25-alpine AS build
RUN apk add --no-cache git
ENV CGO_ENABLED=0 GOOS=linux GOFLAGS=-mod=vendor
WORKDIR /src

# Copy module metadata + vendored deps first so layer caching is friendly.
COPY go.mod go.sum ./
COPY vendor/ ./vendor/

# Then the rest of the source. Note: the ui/ directory is overwritten by
# the COPY --from=ui below; that's intentional — we don't want to ship
# the source ui/web tree to the runtime stage, only its built dist.
COPY . .
COPY --from=ui /ui/dist ./ui/dist
# Sanity check — the Go build expects ./ui/dist/index.html from the
# embed directive in ui/embed.go.
RUN test -f ui/dist/index.html || (echo "ui/dist/index.html missing" && exit 1)

RUN --mount=type=cache,target=/root/.cache/go-build \
    go build -trimpath -ldflags='-s -w' -o /out/discoveryd ./cmd/discoveryd


# ---------- 3. Runtime ----------
FROM alpine:3.20 AS run
RUN apk add --no-cache ca-certificates tini tzdata && \
    addgroup -S discovery -g 10001 && \
    adduser  -S discovery -G discovery -u 10001 && \
    mkdir -p /data && chown discovery:discovery /data

USER discovery
WORKDIR /app
COPY --from=build /out/discoveryd /app/discoveryd

# Default config; deploy.yml overrides via env. /data is mounted as a
# volume by Kamal so the bbolt file survives container replacement.
ENV DISCOVERY_LISTEN=":8500" \
    DISCOVERY_DB="/data/discovery.db" \
    DISCOVERY_LOG="info"

VOLUME ["/data"]
EXPOSE 8500

# tini cleanly forwards SIGTERM → bbolt flushes & closes the WAL.
ENTRYPOINT ["/sbin/tini", "--", "/app/discoveryd"]
