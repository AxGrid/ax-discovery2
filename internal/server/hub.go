package server

import (
	"sync"

	"github.com/axgrid/discovery2/internal/model"
	"github.com/axgrid/discovery2/internal/store"
)

// Hub fans out store events to connected WebSocket clients.
type Hub struct {
	store *store.Store

	mu      sync.RWMutex
	clients map[*wsClient]struct{}
}

func NewHub(s *store.Store) *Hub {
	return &Hub{store: s, clients: make(map[*wsClient]struct{})}
}

func (h *Hub) add(c *wsClient) {
	h.mu.Lock()
	h.clients[c] = struct{}{}
	h.mu.Unlock()
}

func (h *Hub) remove(c *wsClient) {
	h.mu.Lock()
	if _, ok := h.clients[c]; ok {
		delete(h.clients, c)
		close(c.send)
	}
	h.mu.Unlock()
}

// Run reads events from the store and pushes them to every connected client.
// Slow clients are dropped (closed) rather than blocking the broadcaster.
func (h *Hub) Run(stop <-chan struct{}) {
	sub := h.store.Subscribe(512)
	defer h.store.Unsubscribe(sub)
	for {
		select {
		case <-stop:
			return
		case ev, ok := <-sub.C():
			if !ok {
				return
			}
			h.broadcast(ev)
		}
	}
}

func (h *Hub) broadcast(ev model.Event) {
	h.mu.RLock()
	dead := make([]*wsClient, 0)
	for c := range h.clients {
		select {
		case c.send <- ev:
		default:
			dead = append(dead, c)
		}
	}
	h.mu.RUnlock()
	for _, c := range dead {
		h.remove(c)
	}
}
