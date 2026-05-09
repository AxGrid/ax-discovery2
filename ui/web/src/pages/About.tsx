export default function About() {
  return (
    <div className="p-6 max-w-3xl mx-auto">
      <h1 className="text-2xl font-semibold tracking-tight mb-6">About</h1>
      <div className="card space-y-4 text-sm">
        <p>
          A small service-discovery server with a Go client library and a React UI.
          Multiple nodes form a fault-tolerant cluster via gossip; instance health is tracked
          by heartbeats, optional active probes, and TTL.
        </p>
        <div>
          <div className="font-semibold mb-1">Quick start</div>
          <pre className="bg-zinc-100 dark:bg-zinc-800 rounded-lg p-3 text-xs overflow-x-auto"><code>{`# Single node
go run ./cmd/discoveryd

# Two-node cluster (example)
DISCOVERY_NODE_ID=a DISCOVERY_LISTEN=:8500 \\
  DISCOVERY_GOSSIP_PORT=7946 go run ./cmd/discoveryd
DISCOVERY_NODE_ID=b DISCOVERY_LISTEN=:8501 \\
  DISCOVERY_GOSSIP_PORT=7947 \\
  DISCOVERY_SEEDS=127.0.0.1:7946 \\
  DISCOVERY_DB=./b.db go run ./cmd/discoveryd`}</code></pre>
        </div>
        <div>
          <div className="font-semibold mb-1">Client library</div>
          <pre className="bg-zinc-100 dark:bg-zinc-800 rounded-lg p-3 text-xs overflow-x-auto"><code>{`import "github.com/zed/discovery/pkg/client"

c := client.New("http://disc1:8500,http://disc2:8500",
    client.WithToken("write-token"))

reg, _ := c.Register(ctx, client.Registration{
    Service: "billing",
    Address: "10.0.0.5",
    Interfaces: []client.Interface{
        {Name: "WEB", Protocol: "http", Port: 8080, HealthURL: "/healthz"},
        {Name: "GRPC", Protocol: "tcp", Port: 9000},
    },
    TTLSeconds: 30,
})
defer reg.Close()

res, _ := c.NewResolver(ctx, "billing", client.RoundRobin)
addr, _ := res.PickAddress("WEB") // 10.0.0.5:8080`}</code></pre>
        </div>
      </div>
    </div>
  );
}
