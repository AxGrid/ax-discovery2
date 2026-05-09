package store

import (
	"path/filepath"
	"testing"

	"github.com/axgrid/discovery2/internal/model"
)

func newStore(t *testing.T) *Store {
	t.Helper()
	dir := t.TempDir()
	s, err := Open(filepath.Join(dir, "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

func TestServiceCRUD(t *testing.T) {
	s := newStore(t)
	svc := &model.Service{Name: "billing", Description: "billing svc"}
	if err := s.PutService(svc); err != nil {
		t.Fatal(err)
	}
	got, err := s.GetService("billing")
	if err != nil {
		t.Fatal(err)
	}
	if got.Name != "billing" {
		t.Fatalf("name mismatch: %s", got.Name)
	}
	list, err := s.ListServices()
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 {
		t.Fatalf("want 1, got %d", len(list))
	}
	if err := s.DeleteService("billing"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.GetService("billing"); err == nil {
		t.Fatal("expected ErrNotFound")
	}
}

func TestInstanceLifecycle(t *testing.T) {
	s := newStore(t)
	inst := &model.Instance{
		ID:          "i1",
		ServiceName: "billing",
		Address:     "10.0.0.5",
		Interfaces: []model.Interface{
			{Name: "WEB", Protocol: "http", Port: 8080},
		},
		TTLSeconds: 30,
	}
	if err := s.PutInstance(inst); err != nil {
		t.Fatal(err)
	}
	got, err := s.GetInstance("billing", "i1")
	if err != nil {
		t.Fatal(err)
	}
	if got.Address != "10.0.0.5" {
		t.Fatalf("address mismatch")
	}
	// Service stub auto-created
	if _, err := s.GetService("billing"); err != nil {
		t.Fatalf("expected stub service: %v", err)
	}
	// Heartbeat updates LastHeartbeat
	if _, err := s.Heartbeat("billing", "i1", model.StatusUp); err != nil {
		t.Fatal(err)
	}
	// SetStatus changes status
	updated, err := s.SetStatus("billing", "i1", model.StatusDown)
	if err != nil {
		t.Fatal(err)
	}
	if updated.Status != model.StatusDown {
		t.Fatalf("status not changed")
	}
	// Cascade delete
	if err := s.DeleteService("billing"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.GetInstance("billing", "i1"); err == nil {
		t.Fatal("expected cascade delete")
	}
}

func TestSubscribe(t *testing.T) {
	s := newStore(t)
	sub := s.Subscribe(8)
	defer s.Unsubscribe(sub)
	if err := s.PutService(&model.Service{Name: "a"}); err != nil {
		t.Fatal(err)
	}
	select {
	case ev := <-sub.C():
		if ev.Type != model.EventServiceUpserted {
			t.Fatalf("unexpected event %s", ev.Type)
		}
	default:
		t.Fatal("no event received")
	}
}
