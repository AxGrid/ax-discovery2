package health

import (
	"testing"

	"github.com/axgrid/discovery2/internal/model"
)

func TestBuildProbeURL(t *testing.T) {
	cases := []struct {
		name string
		host string
		it   model.Interface
		want string
	}{
		{
			name: "full URL in HealthURL is used verbatim",
			host: "ignored",
			it:   model.Interface{HealthURL: "https://other.example.com/healthz", Protocol: "http", Port: 8080},
			want: "https://other.example.com/healthz",
		},
		{
			name: "HTTPS on default port omits :443",
			host: "cashier-ui.r.axgrid.com",
			it:   model.Interface{Protocol: "https", Port: 443},
			want: "https://cashier-ui.r.axgrid.com/",
		},
		{
			name: "HTTP on default port omits :80",
			host: "example.com",
			it:   model.Interface{Protocol: "http", Port: 80},
			want: "http://example.com/",
		},
		{
			name: "non-default port is kept",
			host: "10.0.0.5",
			it:   model.Interface{Protocol: "http", Port: 8080, Path: "/api"},
			want: "http://10.0.0.5:8080/api",
		},
		{
			name: "port 0 is treated as default (proxy-fronted)",
			host: "svc.internal",
			it:   model.Interface{Protocol: "https", Port: 0},
			want: "https://svc.internal/",
		},
		{
			name: "HealthURL as bare path overrides Path",
			host: "10.0.0.5",
			it:   model.Interface{Protocol: "http", Port: 8080, Path: "/api", HealthURL: "/healthz"},
			want: "http://10.0.0.5:8080/healthz",
		},
		{
			name: "HealthURL path missing leading slash gets one",
			host: "10.0.0.5",
			it:   model.Interface{Protocol: "http", Port: 8080, HealthURL: "ping"},
			want: "http://10.0.0.5:8080/ping",
		},
		{
			name: "TLS flag overrides protocol",
			host: "svc",
			it:   model.Interface{Protocol: "http", Port: 9000, TLS: true},
			want: "https://svc:9000/",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := buildProbeURL(c.host, c.it); got != c.want {
				t.Fatalf("got %q, want %q", got, c.want)
			}
		})
	}
}
