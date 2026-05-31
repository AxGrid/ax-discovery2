package store

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	bolt "go.etcd.io/bbolt"

	"github.com/axgrid/discovery2/internal/model"
)

var (
	bktServices     = []byte("services")
	bktInstances    = []byte("instances")
	bktSessions     = []byte("sessions")
	bktAffinity     = []byte("affinity")      // key: service + "/" + token (sticky load-balancing bindings)
	bktConfig       = []byte("config")        // key: active/<scope> | rev/<scope>/<n> | draft/<scope>
	bktClientTokens = []byte("client_tokens") // key: token secret → ClientToken
	bktAudit        = []byte("audit")         // key: timestamp_unix_nano + "/" + uuid (sorted ascending)

	ErrNotFound = errors.New("not found")
	ErrConflict = errors.New("conflict")
)

// Subscriber receives change events. The channel is closed when Unsubscribe is called.
type Subscriber struct {
	ch chan model.Event
}

func (s *Subscriber) C() <-chan model.Event { return s.ch }

// Store persists services and instances in a bbolt file with in-memory event fan-out.
type Store struct {
	db *bolt.DB

	mu   sync.RWMutex
	subs map[*Subscriber]struct{}
}

// Open creates or opens a bbolt database at the given path.
func Open(path string) (*Store, error) {
	db, err := bolt.Open(path, 0o600, &bolt.Options{Timeout: 2 * time.Second})
	if err != nil {
		return nil, fmt.Errorf("open bbolt: %w", err)
	}
	err = db.Update(func(tx *bolt.Tx) error {
		for _, b := range [][]byte{bktServices, bktInstances, bktSessions, bktAffinity, bktConfig, bktClientTokens, bktAudit} {
			if _, err := tx.CreateBucketIfNotExists(b); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		_ = db.Close()
		return nil, err
	}
	return &Store{db: db, subs: make(map[*Subscriber]struct{})}, nil
}

func (s *Store) Close() error { return s.db.Close() }

// Subscribe returns a Subscriber that receives all change events.
// Slow consumers will drop events rather than block writers.
func (s *Store) Subscribe(buffer int) *Subscriber {
	if buffer <= 0 {
		buffer = 64
	}
	sub := &Subscriber{ch: make(chan model.Event, buffer)}
	s.mu.Lock()
	s.subs[sub] = struct{}{}
	s.mu.Unlock()
	return sub
}

func (s *Store) Unsubscribe(sub *Subscriber) {
	s.mu.Lock()
	if _, ok := s.subs[sub]; ok {
		delete(s.subs, sub)
		close(sub.ch)
	}
	s.mu.Unlock()
}

func (s *Store) emit(ev model.Event) {
	if ev.Timestamp.IsZero() {
		ev.Timestamp = time.Now().UTC()
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	for sub := range s.subs {
		select {
		case sub.ch <- ev:
		default:
		}
	}
}

// PutService creates or updates a service definition.
func (s *Store) PutService(svc *model.Service) error {
	if err := svc.Validate(); err != nil {
		return err
	}
	now := time.Now().UTC()
	if svc.CreatedAt.IsZero() {
		svc.CreatedAt = now
	}
	svc.UpdatedAt = now
	err := s.db.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket(bktServices)
		buf, err := json.Marshal(svc)
		if err != nil {
			return err
		}
		return b.Put([]byte(svc.Name), buf)
	})
	if err != nil {
		return err
	}
	s.emit(model.Event{Type: model.EventServiceUpserted, Service: svc.Name, Payload: svc})
	return nil
}

func (s *Store) GetService(name string) (*model.Service, error) {
	var svc model.Service
	err := s.db.View(func(tx *bolt.Tx) error {
		v := tx.Bucket(bktServices).Get([]byte(name))
		if v == nil {
			return ErrNotFound
		}
		return json.Unmarshal(v, &svc)
	})
	if err != nil {
		return nil, err
	}
	return &svc, nil
}

func (s *Store) ListServices() ([]model.Service, error) {
	var out []model.Service
	err := s.db.View(func(tx *bolt.Tx) error {
		return tx.Bucket(bktServices).ForEach(func(_, v []byte) error {
			var svc model.Service
			if err := json.Unmarshal(v, &svc); err != nil {
				return err
			}
			out = append(out, svc)
			return nil
		})
	})
	return out, err
}

func (s *Store) DeleteService(name string) error {
	err := s.db.Update(func(tx *bolt.Tx) error {
		bs := tx.Bucket(bktServices)
		if bs.Get([]byte(name)) == nil {
			return ErrNotFound
		}
		if err := bs.Delete([]byte(name)); err != nil {
			return err
		}
		// cascade delete instances belonging to this service
		bi := tx.Bucket(bktInstances)
		c := bi.Cursor()
		prefix := []byte(name + "/")
		var toDelete [][]byte
		for k, _ := c.Seek(prefix); k != nil && hasPrefix(k, prefix); k, _ = c.Next() {
			cp := make([]byte, len(k))
			copy(cp, k)
			toDelete = append(toDelete, cp)
		}
		for _, k := range toDelete {
			if err := bi.Delete(k); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return err
	}
	s.emit(model.Event{Type: model.EventServiceDeleted, Service: name})
	return nil
}

// PutInstance creates or updates an instance registration.
func (s *Store) PutInstance(inst *model.Instance) error {
	if err := inst.Validate(); err != nil {
		return err
	}
	now := time.Now().UTC()
	if inst.RegisteredAt.IsZero() {
		inst.RegisteredAt = now
	}
	inst.UpdatedAt = now
	if inst.LastHeartbeat.IsZero() {
		inst.LastHeartbeat = now
	}
	key := instanceKey(inst.ServiceName, inst.ID)
	err := s.db.Update(func(tx *bolt.Tx) error {
		// Preserve the operator Blocked kill-switch across re-registration —
		// a self-managed client must not be able to un-block itself simply by
		// sending a fresh PUT (Blocked isn't in the registration payload).
		if existing := tx.Bucket(bktInstances).Get(key); existing != nil {
			var prev model.Instance
			if err := json.Unmarshal(existing, &prev); err == nil {
				inst.Blocked = prev.Blocked
			}
		}
		// Ensure service exists; auto-create a stub if missing for ergonomic registration.
		bs := tx.Bucket(bktServices)
		if bs.Get([]byte(inst.ServiceName)) == nil {
			stub := &model.Service{Name: inst.ServiceName, CreatedAt: now, UpdatedAt: now}
			buf, err := json.Marshal(stub)
			if err != nil {
				return err
			}
			if err := bs.Put([]byte(inst.ServiceName), buf); err != nil {
				return err
			}
		}
		buf, err := json.Marshal(inst)
		if err != nil {
			return err
		}
		return tx.Bucket(bktInstances).Put(key, buf)
	})
	if err != nil {
		return err
	}
	s.emit(model.Event{
		Type:     model.EventInstanceUpserted,
		Service:  inst.ServiceName,
		Instance: inst.ID,
		Payload:  inst,
	})
	return nil
}

// Heartbeat updates LastHeartbeat and Status for an existing instance.
// Returns ErrNotFound if the instance is unknown — callers should re-register.
//
// Status semantics:
//   - if the caller passes an explicit status, it wins (lets clients flip
//     themselves into draining/starting).
//   - if the caller passes "", we lift Down → Up: the heartbeat itself is
//     the proof of life. This is the recovery path after a network blip,
//     laptop sleep, or any other event that let the TTL sweeper mark the
//     instance Down. Without this lift, the instance stayed red forever
//     even though its client kept heartbeating.
//   - other states (draining, starting) are preserved on empty status —
//     they're explicit operator/client choices, and a heartbeat shouldn't
//     undo them.
func (s *Store) Heartbeat(service, id string, status model.Status) (*model.Instance, error) {
	key := instanceKey(service, id)
	var updated model.Instance
	err := s.db.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket(bktInstances)
		v := b.Get(key)
		if v == nil {
			return ErrNotFound
		}
		if err := json.Unmarshal(v, &updated); err != nil {
			return err
		}
		updated.LastHeartbeat = time.Now().UTC()
		updated.UpdatedAt = updated.LastHeartbeat
		switch {
		case status != "":
			updated.Status = status
		case updated.Status == model.StatusDown:
			updated.Status = model.StatusUp
		}
		buf, err := json.Marshal(&updated)
		if err != nil {
			return err
		}
		return b.Put(key, buf)
	})
	if err != nil {
		return nil, err
	}
	s.emit(model.Event{
		Type:     model.EventInstanceStatus,
		Service:  service,
		Instance: id,
		Payload:  &updated,
	})
	return &updated, nil
}

// SetLastCheck persists the result of a health probe on the instance without
// touching Status. Does NOT emit an event — per-probe noise would flood the
// gossip channel; UI sees fresh data on the next status flip or page refresh.
func (s *Store) SetLastCheck(service, id string, check *model.InstanceCheck) error {
	key := instanceKey(service, id)
	return s.db.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket(bktInstances)
		v := b.Get(key)
		if v == nil {
			return ErrNotFound
		}
		var inst model.Instance
		if err := json.Unmarshal(v, &inst); err != nil {
			return err
		}
		inst.LastCheck = check
		buf, err := json.Marshal(&inst)
		if err != nil {
			return err
		}
		return b.Put(key, buf)
	})
}

// SetStatus forces the status field on an instance (used by health probes / TTL sweeper).
func (s *Store) SetStatus(service, id string, status model.Status) (*model.Instance, error) {
	key := instanceKey(service, id)
	var updated model.Instance
	var changed bool
	err := s.db.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket(bktInstances)
		v := b.Get(key)
		if v == nil {
			return ErrNotFound
		}
		if err := json.Unmarshal(v, &updated); err != nil {
			return err
		}
		if updated.Status == status {
			return nil
		}
		updated.Status = status
		updated.UpdatedAt = time.Now().UTC()
		changed = true
		buf, err := json.Marshal(&updated)
		if err != nil {
			return err
		}
		return b.Put(key, buf)
	})
	if err != nil {
		return nil, err
	}
	if changed {
		s.emit(model.Event{
			Type:     model.EventInstanceStatus,
			Service:  service,
			Instance: id,
			Payload:  &updated,
		})
	}
	return &updated, nil
}

// SetBlocked toggles the operator kill-switch on an instance. A blocked
// instance stays in the catalog (and keeps its UP/DOWN status) but is filtered
// out of /discover and /pick. Bumps UpdatedAt and emits so the change wins
// last-write-wins replication and reaches peers + the UI immediately.
func (s *Store) SetBlocked(service, id string, blocked bool) (*model.Instance, error) {
	key := instanceKey(service, id)
	var updated model.Instance
	err := s.db.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket(bktInstances)
		v := b.Get(key)
		if v == nil {
			return ErrNotFound
		}
		if err := json.Unmarshal(v, &updated); err != nil {
			return err
		}
		updated.Blocked = blocked
		updated.UpdatedAt = time.Now().UTC()
		buf, err := json.Marshal(&updated)
		if err != nil {
			return err
		}
		return b.Put(key, buf)
	})
	if err != nil {
		return nil, err
	}
	s.emit(model.Event{
		Type:     model.EventInstanceUpserted,
		Service:  service,
		Instance: id,
		Payload:  &updated,
	})
	return &updated, nil
}

func (s *Store) GetInstance(service, id string) (*model.Instance, error) {
	var inst model.Instance
	err := s.db.View(func(tx *bolt.Tx) error {
		v := tx.Bucket(bktInstances).Get(instanceKey(service, id))
		if v == nil {
			return ErrNotFound
		}
		return json.Unmarshal(v, &inst)
	})
	if err != nil {
		return nil, err
	}
	return &inst, nil
}

func (s *Store) ListInstances(service string) ([]model.Instance, error) {
	var out []model.Instance
	err := s.db.View(func(tx *bolt.Tx) error {
		c := tx.Bucket(bktInstances).Cursor()
		prefix := []byte(service + "/")
		for k, v := c.Seek(prefix); k != nil && hasPrefix(k, prefix); k, v = c.Next() {
			var inst model.Instance
			if err := json.Unmarshal(v, &inst); err != nil {
				return err
			}
			out = append(out, inst)
		}
		return nil
	})
	return out, err
}

func (s *Store) ListAllInstances() ([]model.Instance, error) {
	var out []model.Instance
	err := s.db.View(func(tx *bolt.Tx) error {
		return tx.Bucket(bktInstances).ForEach(func(_, v []byte) error {
			var inst model.Instance
			if err := json.Unmarshal(v, &inst); err != nil {
				return err
			}
			out = append(out, inst)
			return nil
		})
	})
	return out, err
}

func (s *Store) DeleteInstance(service, id string) error {
	key := instanceKey(service, id)
	var existed bool
	err := s.db.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket(bktInstances)
		if b.Get(key) == nil {
			return nil
		}
		existed = true
		return b.Delete(key)
	})
	if err != nil {
		return err
	}
	if existed {
		s.emit(model.Event{Type: model.EventInstanceDeleted, Service: service, Instance: id})
	}
	return nil
}

// Snapshot returns the full current state for cluster sync.
type Snapshot struct {
	Services     []model.Service        `json:"services"`
	Instances    []model.Instance       `json:"instances"`
	Affinity     []model.Affinity       `json:"affinity,omitempty"`
	ConfigRevs   []model.ConfigRevision `json:"configRevs,omitempty"`
	ConfigDrafts []model.ConfigDraft    `json:"configDrafts,omitempty"`
	ClientTokens []model.ClientToken    `json:"clientTokens,omitempty"`
}

func (s *Store) Snapshot() (*Snapshot, error) {
	svcs, err := s.ListServices()
	if err != nil {
		return nil, err
	}
	insts, err := s.ListAllInstances()
	if err != nil {
		return nil, err
	}
	affs, err := s.ListAffinity()
	if err != nil {
		return nil, err
	}
	revs, drafts, err := s.configSnapshot()
	if err != nil {
		return nil, err
	}
	toks, err := s.clientTokenSnapshot()
	if err != nil {
		return nil, err
	}
	return &Snapshot{
		Services: svcs, Instances: insts, Affinity: affs,
		ConfigRevs: revs, ConfigDrafts: drafts, ClientTokens: toks,
	}, nil
}

// ApplyRemote merges a remote event into local state.
// Last-write-wins on UpdatedAt timestamps.
func (s *Store) ApplyRemote(ev model.Event) error {
	switch ev.Type {
	case model.EventServiceUpserted:
		var svc model.Service
		if err := remarshal(ev.Payload, &svc); err != nil {
			return err
		}
		existing, err := s.GetService(svc.Name)
		if err == nil && !existing.UpdatedAt.Before(svc.UpdatedAt) {
			return nil
		}
		// bypass emit by writing directly, then emit a fan-out without OriginID swap
		return s.putServiceRaw(&svc, ev)
	case model.EventServiceDeleted:
		return s.deleteServiceRaw(ev.Service, ev)
	case model.EventInstanceUpserted, model.EventInstanceStatus:
		var inst model.Instance
		if err := remarshal(ev.Payload, &inst); err != nil {
			return err
		}
		existing, err := s.GetInstance(inst.ServiceName, inst.ID)
		if err == nil && !existing.UpdatedAt.Before(inst.UpdatedAt) {
			return nil
		}
		return s.putInstanceRaw(&inst, ev)
	case model.EventInstanceDeleted:
		return s.deleteInstanceRaw(ev.Service, ev.Instance, ev)
	case model.EventAffinityUpserted:
		var a model.Affinity
		if err := remarshal(ev.Payload, &a); err != nil {
			return err
		}
		existing, err := s.getAffinityRaw(a.ServiceName, a.Token)
		if err == nil && !existing.UpdatedAt.Before(a.UpdatedAt) {
			return nil
		}
		return s.putAffinityRaw(&a, ev)
	case model.EventAffinityDeleted:
		var a model.Affinity
		if err := remarshal(ev.Payload, &a); err != nil {
			return err
		}
		return s.deleteAffinityRaw(a.ServiceName, a.Token, ev)
	case model.EventConfigApplied, model.EventConfigDraftSaved,
		model.EventConfigDraftDeleted, model.EventConfigDeleted:
		return s.applyConfigRemote(ev)
	case model.EventTokenUpserted, model.EventTokenDeleted:
		return s.applyTokenRemote(ev)
	}
	return nil
}

func (s *Store) putServiceRaw(svc *model.Service, ev model.Event) error {
	err := s.db.Update(func(tx *bolt.Tx) error {
		buf, err := json.Marshal(svc)
		if err != nil {
			return err
		}
		return tx.Bucket(bktServices).Put([]byte(svc.Name), buf)
	})
	if err != nil {
		return err
	}
	s.emit(ev)
	return nil
}

func (s *Store) deleteServiceRaw(name string, ev model.Event) error {
	err := s.db.Update(func(tx *bolt.Tx) error {
		return tx.Bucket(bktServices).Delete([]byte(name))
	})
	if err != nil {
		return err
	}
	s.emit(ev)
	return nil
}

func (s *Store) putInstanceRaw(inst *model.Instance, ev model.Event) error {
	err := s.db.Update(func(tx *bolt.Tx) error {
		buf, err := json.Marshal(inst)
		if err != nil {
			return err
		}
		return tx.Bucket(bktInstances).Put(instanceKey(inst.ServiceName, inst.ID), buf)
	})
	if err != nil {
		return err
	}
	s.emit(ev)
	return nil
}

func (s *Store) deleteInstanceRaw(service, id string, ev model.Event) error {
	err := s.db.Update(func(tx *bolt.Tx) error {
		return tx.Bucket(bktInstances).Delete(instanceKey(service, id))
	})
	if err != nil {
		return err
	}
	s.emit(ev)
	return nil
}

func instanceKey(service, id string) []byte {
	return []byte(service + "/" + id)
}

func hasPrefix(b, prefix []byte) bool {
	if len(b) < len(prefix) {
		return false
	}
	return string(b[:len(prefix)]) == string(prefix)
}

func remarshal(in interface{}, out interface{}) error {
	buf, err := json.Marshal(in)
	if err != nil {
		return err
	}
	return json.Unmarshal(buf, out)
}

// Helper: split instance key for tooling.
func splitInstanceKey(k []byte) (service, id string, ok bool) {
	parts := strings.SplitN(string(k), "/", 2)
	if len(parts) != 2 {
		return "", "", false
	}
	return parts[0], parts[1], true
}

var _ = splitInstanceKey
