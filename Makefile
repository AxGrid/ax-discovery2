.PHONY: all ui ui-deps run run-cluster build go-build \
        build-linux build-linux-amd64 build-linux-arm64 build-all \
        test clean \
        vendor docker-build docker-run kamal-setup kamal-deploy kamal-redeploy kamal-logs kamal-status

# Strip symbols + DWARF for cross-built Linux binaries. ~30% smaller, no
# debugger experience on the binary, but we keep symbols on the native build.
LINUX_LDFLAGS := -ldflags=-s -w

all: build

# Install npm deps. The sentinel file means re-installs only happen when
# package.json or package-lock.json change, not on every `make`.
ui/web/node_modules/.installed: ui/web/package.json
	cd ui/web && npm install
	@touch $@

ui-deps: ui/web/node_modules/.installed

# Build the React UI into ui/dist (embedded by Go).
ui: ui-deps
	cd ui/web && npm run build

# Compile the Go daemon. Doesn't touch the UI — use plain `make build` for that.
# Output goes to ./bin/discoveryd and is also copied to ./discoveryd (project
# root) so it's right next to .env when you `./discoveryd`.
#
# On macOS we re-sign ad-hoc after build. The Go linker emits a "linker-signed"
# signature, which macOS Sequoia kills (SIGKILL, exit 137) on launch for
# binaries that embed large data sections (our embedded UI). A plain ad-hoc
# signature via `codesign -s -` works. No-op on Linux.
go-build:
	mkdir -p bin
	go build -o bin/discoveryd ./cmd/discoveryd
	cp bin/discoveryd ./discoveryd
	@if [ "$$(uname)" = "Darwin" ]; then \
	    codesign -s - -f bin/discoveryd >/dev/null 2>&1; \
	    codesign -s - -f ./discoveryd >/dev/null 2>&1; \
	fi

# Default build: UI then binary, producing a self-contained ./discoveryd
# with the latest UI embedded.
build: ui go-build

# --- Linux cross-compile -----------------------------------------------------
# All deps are pure Go, so CGO_ENABLED=0 gives us static binaries that run on
# any glibc/musl without compatibility headaches. Output lands next to the
# native build but with a -linux-<arch> suffix.

build-linux-amd64: ui
	mkdir -p bin
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
	    go build "$(LINUX_LDFLAGS)" -o bin/discoveryd-linux-amd64 ./cmd/discoveryd

build-linux-arm64: ui
	mkdir -p bin
	CGO_ENABLED=0 GOOS=linux GOARCH=arm64 \
	    go build "$(LINUX_LDFLAGS)" -o bin/discoveryd-linux-arm64 ./cmd/discoveryd

# Build both common Linux archs at once.
build-linux: build-linux-amd64 build-linux-arm64

# Native + both Linux archs. Useful before cutting a release.
build-all: build build-linux

# Build everything and run on :8500. Open http://localhost:8500.
run: build
	./discoveryd

# Two-node cluster on this machine. Open http://localhost:8500 and :8501.
run-cluster: build
	rm -f a.db b.db
	(./bin/discoveryd \
	    -listen :8500 -gossip-port 7946 \
	    -node-id a -db a.db &) ; \
	sleep 0.5 ; \
	./bin/discoveryd \
	    -listen :8501 -gossip-port 7947 \
	    -node-id b -db b.db \
	    -seeds 127.0.0.1:7946

test:
	go test ./...

clean:
	rm -rf bin ui/dist ui/web/node_modules ./discoveryd

# --- Kamal deploy --------------------------------------------------------
# vendor regenerates ./vendor/ so the Docker build can resolve the local
# replace directive for github.com/corp-ui/corp-ui/sdk/go. The directory
# is gitignored; rerun whenever go.mod or the corp-ui SDK changes.
vendor:
	go mod vendor

# Local docker build, no push. Useful for smoke-testing the Dockerfile
# before letting Kamal push to the real registry. Produces a local
# `ax-discovery2:dev` tag.
docker-build: vendor
	docker build -t ax-discovery2:dev .

# Run the locally-built image on :18500 with an in-process bbolt file.
# Won't talk to corp-ui without -e CORP_URL=… ; this target is for the
# "does the container even start" check, not a working app.
docker-run: docker-build
	docker run --rm -it -p 18500:8500 \
	    -e DISCOVERY_ALLOW_ANON_READ=true \
	    ax-discovery2:dev

# First-time bootstrap: build image + push + register kamal-proxy on the
# host + deploy the first version. Requires .kamal/secrets to be filled
# and `kamal proxy boot --ssl-email=info@axgrid.com` to have been run
# beforehand (see config/deploy.yml header).
#
# Also pre-creates the bbolt volume directory on the host with uid:gid
# 10001:10001 (the `discovery` user from the Dockerfile). Without this,
# the first deploy crash-loops with "open bbolt: permission denied"
# because Docker bind-mounts inherit the host directory's owner, not
# the image's.
kamal-setup: vendor kamal-ensure-volume
	kamal setup

kamal-ensure-volume:
	@host=$$(awk '/^servers:/,/^[a-z]+:/' config/deploy.yml | awk '/-[[:space:]]/{print $$2; exit}'); \
	    user=$$(awk '/^ssh:/,/^[a-z]+:/' config/deploy.yml | awk '/user:/{print $$2; exit}'); \
	    if [ -z "$$host" ] || [ -z "$$user" ]; then echo "could not detect host/user from deploy.yml"; exit 1; fi; \
	    echo "ensuring /srv/ax-discovery2/data on $$user@$$host belongs to 10001:10001"; \
	    ssh $$user@$$host 'mkdir -p /srv/ax-discovery2/data && chown 10001:10001 /srv/ax-discovery2/data && chmod 0750 /srv/ax-discovery2/data'

# Day-to-day deploys. Rebuilds the image (Kamal tags with the current
# git SHA), pushes to the private registry, rolls the container on the
# host, and kamal-proxy switches traffic only after /v1/health passes.
#
# kamal-ensure-volume is idempotent and cheap (one SSH + chown). Keeping
# it on every deploy means the bbolt directory's ownership is never the
# reason a deploy fails — even if someone reboots the host with a fresh
# /srv or adds a new server to deploy.yml.
kamal-deploy: vendor kamal-ensure-volume
	kamal deploy

# Same image + same env, fresh container. Use after editing
# .kamal/secrets or when you suspect a stuck process.
kamal-redeploy:
	kamal redeploy

kamal-logs:
	kamal app logs -f

kamal-status:
	kamal app details
