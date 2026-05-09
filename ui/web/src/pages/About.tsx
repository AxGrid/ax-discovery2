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
