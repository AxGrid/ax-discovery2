import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui";

export default function About() {
  return (
    <div className="p-6 max-w-3xl mx-auto">
      <h1 className="text-2xl font-semibold tracking-tight mb-6">About</h1>
      <Card>
        <CardContent className="space-y-4 text-sm pt-6">
          <p>
            A small service-discovery server with a Go client library and a React UI.
            Multiple nodes form a fault-tolerant cluster via gossip; instance health is tracked
            by heartbeats, optional active probes, and TTL.
          </p>
        </CardContent>
      </Card>
      <Card className="mt-4">
        <CardHeader><CardTitle className="text-sm">Quick start</CardTitle></CardHeader>
        <CardContent className="pt-0">
          <pre className="bg-surface rounded-[var(--radius-md)] p-3 text-xs overflow-x-auto"><code>{`# Single node
go run ./cmd/discoveryd

# Two-node cluster (example)
DISCOVERY_NODE_ID=a DISCOVERY_LISTEN=:8500 \\
  DISCOVERY_GOSSIP_PORT=7946 go run ./cmd/discoveryd
DISCOVERY_NODE_ID=b DISCOVERY_LISTEN=:8501 \\
  DISCOVERY_GOSSIP_PORT=7947 \\
  DISCOVERY_SEEDS=127.0.0.1:7946 \\
  DISCOVERY_DB=./b.db go run ./cmd/discoveryd`}</code></pre>
        </CardContent>
      </Card>
      <Card className="mt-4">
        <CardHeader><CardTitle className="text-sm">REST quick reference (curl)</CardTitle></CardHeader>
        <CardContent className="pt-0 space-y-4">
          <p className="text-xs text-fg-muted">
            Reads are open to any role; writes need a bearer token. Pass it with
            <code className="mx-1">-H "Authorization: Bearer &lt;token&gt;"</code>
            (mint one under <span className="font-medium">Tokens</span>).
          </p>
          <div>
            <div className="text-xs text-fg-muted mb-1">List services / discover live instances</div>
            <pre className="bg-surface rounded-[var(--radius-md)] p-3 text-xs overflow-x-auto"><code>{`# all services
curl http://localhost:8500/v1/services

# just one, and its instances
curl http://localhost:8500/v1/services/billing
curl http://localhost:8500/v1/services/billing/instances

# discover UP instances, optionally semver-filtered
curl 'http://localhost:8500/v1/discover/billing?version=>=2.1.0'

# flat host:port list for one interface
curl 'http://localhost:8500/v1/discover/billing?format=addr&iface=WEB'

# pick one (weighted; sticky when you pass a token)
curl 'http://localhost:8500/v1/discover/billing/pick?iface=WEB&token=user-42'`}</code></pre>
          </div>
          <div>
            <div className="text-xs text-fg-muted mb-1">Read config variables</div>
            <pre className="bg-surface rounded-[var(--radius-md)] p-3 text-xs overflow-x-auto"><code>{`# effective config for a service at a version
#   (merges global < service < version)
curl 'http://localhost:8500/v1/config/resolve?service=billing&version=2.1.0'

# only some keys / prefixes
curl 'http://localhost:8500/v1/config/resolve?service=billing&prefix=db/'

# cheap change-detection: HEAD returns just the ETag
curl -I 'http://localhost:8500/v1/config/resolve?service=billing'

# inspect a raw scope (active revision + draft + history)
curl 'http://localhost:8500/v1/config/scope?kind=service&service=billing&include=draft,history'`}</code></pre>
          </div>
          <div>
            <div className="text-xs text-fg-muted mb-1">Write config variables</div>
            <pre className="bg-surface rounded-[var(--radius-md)] p-3 text-xs overflow-x-auto"><code>{`# publish a new revision for the service scope
curl -X POST http://localhost:8500/v1/config/apply \\
  -H "Authorization: Bearer $TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{
    "scope": {"kind":"service","service":"billing"},
    "note": "bump pool size",
    "vars": {
      "db/host":     {"type":"string","value":"10.0.0.5"},
      "db/pool":     {"type":"int","value":20},
      "feature/beta":{"type":"bool","value":true}
    }
  }'`}</code></pre>
          </div>
        </CardContent>
      </Card>
      <Card className="mt-4">
        <CardHeader><CardTitle className="text-sm">Client library</CardTitle></CardHeader>
        <CardContent className="pt-0">
          <pre className="bg-surface rounded-[var(--radius-md)] p-3 text-xs overflow-x-auto"><code>{`import discovery "github.com/axgrid/discovery2-client"

c := discovery.New("http://disc1:8500,http://disc2:8500",
    discovery.WithToken("write-token"))

reg, _ := c.Register(ctx, discovery.Registration{
    Service: "billing",
    Address: "10.0.0.5",
    Interfaces: []discovery.Interface{
        {Name: "WEB", Protocol: "http", Port: 8080, HealthURL: "/healthz"},
        {Name: "GRPC", Protocol: "tcp", Port: 9000},
    },
    TTLSeconds: 30,
})
defer reg.Close()

res, _ := c.NewResolver(ctx, "billing", discovery.RoundRobin)
addr, _ := res.PickAddress("WEB") // 10.0.0.5:8080`}</code></pre>
        </CardContent>
      </Card>
    </div>
  );
}
