.PHONY: all ui ui-deps run run-cluster build go-build \
        build-linux build-linux-amd64 build-linux-arm64 build-all \
        test clean

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
