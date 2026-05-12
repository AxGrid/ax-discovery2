.PHONY: all ui ui-deps run run-cluster build go-build \
        build-linux build-linux-amd64 build-linux-arm64 build-all \
        test clean \
        vendor docker-build docker-run \
        kamal-setup kamal-deploy kamal-redeploy kamal-logs kamal-status \
        secrets-edit secrets-encrypt secrets-decrypt secrets-rekey

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
# The bbolt volume directory is chowned to uid 10001 (the `discovery`
# user from the Dockerfile) by `.kamal/hooks/pre-deploy`, which runs
# automatically on every `kamal setup`/`kamal deploy`. Without this,
# the container crash-loops with "open bbolt: permission denied"
# because Docker bind-mounts inherit the host directory's owner.
kamal-setup: vendor .kamal/secrets
	kamal setup

# Day-to-day deploys. Two-step because bbolt is a single-writer store
# (exclusive file lock); Kamal's default rolling deploy would start the
# new container alongside the old, and the new one would fail to open
# /data/discovery.db with "open bbolt: timeout".
#
# `-kamal app stop` releases the lock first (the leading `-` lets the
# build proceed even if nothing was running, e.g. very first deploy).
# Then `kamal deploy` does its usual build + push + boot — kamal-proxy
# switches traffic when /v1/health returns 200.
#
# Total downtime per deploy: ~1-3 min (covers build + push + boot +
# healthcheck). If the build is fully cached, the bottleneck shifts to
# push+boot and you get closer to ~30s. We considered build-push-first /
# stop / deploy-skip-push but `kamal build push` in Kamal 2 only pushes
# an already-built image — it doesn't build — so the split-flow needs
# `kamal build deliver` and tag invariance across both invocations,
# which is fragile with `_uncommitted_<hash>` tags. Reliable > clever.
#
# Volume ownership is enforced by .kamal/hooks/pre-deploy on every
# Kamal command — Kamal feeds the hook the actual host list via
# $KAMAL_HOSTS, no YAML parsing needed.
kamal-deploy: vendor .kamal/secrets
	-kamal app stop
	kamal deploy

# Same image + same env, fresh container. Use after editing
# .kamal/secrets or when you suspect a stuck process.
kamal-redeploy:
	kamal redeploy

kamal-logs:
	kamal app logs -f

kamal-status:
	kamal app details

# --- sops / age secrets management --------------------------------------
# .kamal/secrets is the plaintext dotenv file Kamal sources at deploy
# time. It is gitignored. The encrypted twin .kamal/secrets.enc IS
# committed — recipients listed in .sops.yaml can decrypt it.
#
# Identity: operators reuse their SSH ed25519 key. The age recipient
# (an `age1...` string) is derived from the SSH public key once via
# `ssh-to-age < ~/.ssh/<key>.pub` and pasted into .sops.yaml. The
# matching private key lives at:
#     ~/Library/Application Support/sops/age/keys.txt   (macOS)
#     ~/.config/sops/age/keys.txt                       (Linux)
# and is generated once with:
#     ssh-to-age -private-key -i ~/.ssh/<key> > <keys.txt path>
#     chmod 0600 <keys.txt path>
# That's the *only* place plaintext age private material exists. It's
# OS-scoped, not repo-scoped — never check it in.
#
# Workflow:
#   first-time clone:   set up keys.txt (above), then `make secrets-decrypt`
#   add/edit a secret:  make secrets-edit           (sops opens $EDITOR, re-encrypts on save)
#                                                    then commit .kamal/secrets.enc
#   add a recipient:    edit .sops.yaml, then       make secrets-rekey
#                                                    then commit both files
#
# Day-to-day deploys auto-decrypt — `kamal-deploy` depends on
# `.kamal/secrets`, which has a rule that derives it from .enc when missing
# or older than the encrypted source.

# Auto-decrypt: if .kamal/secrets is missing or older than the encrypted
# twin, regenerate it. Idempotent — re-runs are no-ops in steady state.
.kamal/secrets: .kamal/secrets.enc
	@echo "decrypting .kamal/secrets.enc → .kamal/secrets"
	@sops --decrypt --input-type dotenv --output-type dotenv .kamal/secrets.enc > .kamal/secrets
	@chmod 0600 .kamal/secrets

# Open the encrypted file in $EDITOR. sops decrypts to a temp file, opens
# the editor, and re-encrypts on save with the recipients from .sops.yaml.
# Use this for any change — it never writes plaintext to disk.
secrets-edit:
	sops .kamal/secrets.enc

# One-shot: take an existing plaintext .kamal/secrets and produce
# .kamal/secrets.enc. Use only the first time, before .kamal/secrets.enc
# exists. After that, `secrets-edit` is the way.
secrets-encrypt:
	@if [ ! -f .kamal/secrets ]; then echo "no .kamal/secrets to encrypt"; exit 1; fi
	cp .kamal/secrets .kamal/secrets.enc
	sops --encrypt --in-place --input-type dotenv --output-type dotenv .kamal/secrets.enc

# Decrypt explicitly. Same as the file-target rule above but always runs.
secrets-decrypt:
	sops --decrypt --input-type dotenv --output-type dotenv .kamal/secrets.enc > .kamal/secrets
	chmod 0600 .kamal/secrets

# Re-encrypt for the current set of recipients in .sops.yaml. Run after
# adding/removing operators. Doesn't change any secret values — only
# the wrapped data-encryption keys.
secrets-rekey:
	sops updatekeys --yes .kamal/secrets.enc
