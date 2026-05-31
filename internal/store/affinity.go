package store

import (
	"encoding/json"
	"time"

	bolt "go.etcd.io/bbolt"

	"github.com/axgrid/discovery2/internal/model"
)

// affinityKey scopes a token to a service. Tokens are opaque (may contain any
// byte including '/'), and we never parse the key back — the Affinity row
// carries ServiceName/Token explicitly — so a naive concatenation is safe.
func affinityKey(service, token string) []byte {
	return []byte(service + "/" + token)
}

// PutAffinity writes a sticky binding. emit controls cluster replication:
// callers pass true on create / re-bind (the instance changed) and false on a
// pure idle-timeout refresh, so a busy token doesn't flood gossip with an
// event per request — mirrors SetLastCheck's "write but don't emit" stance.
func (s *Store) PutAffinity(a *model.Affinity, emit bool) error {
	now := time.Now().UTC()
	if a.CreatedAt.IsZero() {
		a.CreatedAt = now
	}
	a.UpdatedAt = now
	err := s.db.Update(func(tx *bolt.Tx) error {
		buf, err := json.Marshal(a)
		if err != nil {
			return err
		}
		return tx.Bucket(bktAffinity).Put(affinityKey(a.ServiceName, a.Token), buf)
	})
	if err != nil {
		return err
	}
	if emit {
		s.emit(model.Event{
			Type:     model.EventAffinityUpserted,
			Service:  a.ServiceName,
			Instance: a.InstanceID,
			Payload:  a,
		})
	}
	return nil
}

// GetAffinity returns a live binding, transparently expiring (and deleting) one
// past its idle window. Returns ErrNotFound when missing or expired.
func (s *Store) GetAffinity(service, token string) (*model.Affinity, error) {
	a, err := s.getAffinityRaw(service, token)
	if err != nil {
		return nil, err
	}
	if !a.ExpiresAt.IsZero() && a.ExpiresAt.Before(time.Now()) {
		_ = s.DeleteAffinity(service, token)
		return nil, ErrNotFound
	}
	return a, nil
}

// getAffinityRaw reads a binding without applying the idle-timeout. Used by
// ApplyRemote for last-write-wins comparison, where expiry must not interfere.
func (s *Store) getAffinityRaw(service, token string) (*model.Affinity, error) {
	var a model.Affinity
	err := s.db.View(func(tx *bolt.Tx) error {
		v := tx.Bucket(bktAffinity).Get(affinityKey(service, token))
		if v == nil {
			return ErrNotFound
		}
		return json.Unmarshal(v, &a)
	})
	if err != nil {
		return nil, err
	}
	return &a, nil
}

func (s *Store) DeleteAffinity(service, token string) error {
	return s.db.Update(func(tx *bolt.Tx) error {
		return tx.Bucket(bktAffinity).Delete(affinityKey(service, token))
	})
}

// ListAffinity returns every stored binding (including not-yet-swept expired
// ones). Used for the cluster snapshot; peers expire on read.
func (s *Store) ListAffinity() ([]model.Affinity, error) {
	var out []model.Affinity
	err := s.db.View(func(tx *bolt.Tx) error {
		return tx.Bucket(bktAffinity).ForEach(func(_, v []byte) error {
			var a model.Affinity
			if err := json.Unmarshal(v, &a); err != nil {
				return nil
			}
			out = append(out, a)
			return nil
		})
	})
	return out, err
}

// SweepExpiredAffinity removes bindings past their idle window. Safe to call
// periodically.
func (s *Store) SweepExpiredAffinity() (int, error) {
	now := time.Now()
	var keys [][]byte
	err := s.db.View(func(tx *bolt.Tx) error {
		return tx.Bucket(bktAffinity).ForEach(func(k, v []byte) error {
			var a model.Affinity
			if err := json.Unmarshal(v, &a); err != nil {
				return nil
			}
			if !a.ExpiresAt.IsZero() && a.ExpiresAt.Before(now) {
				keys = append(keys, append([]byte(nil), k...))
			}
			return nil
		})
	})
	if err != nil {
		return 0, err
	}
	if len(keys) == 0 {
		return 0, nil
	}
	err = s.db.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket(bktAffinity)
		for _, k := range keys {
			_ = b.Delete(k)
		}
		return nil
	})
	return len(keys), err
}

// --- cluster replication helpers (parallel to putServiceRaw etc.) ---

func (s *Store) putAffinityRaw(a *model.Affinity, ev model.Event) error {
	err := s.db.Update(func(tx *bolt.Tx) error {
		buf, err := json.Marshal(a)
		if err != nil {
			return err
		}
		return tx.Bucket(bktAffinity).Put(affinityKey(a.ServiceName, a.Token), buf)
	})
	if err != nil {
		return err
	}
	s.emit(ev)
	return nil
}

func (s *Store) deleteAffinityRaw(service, token string, ev model.Event) error {
	err := s.db.Update(func(tx *bolt.Tx) error {
		return tx.Bucket(bktAffinity).Delete(affinityKey(service, token))
	})
	if err != nil {
		return err
	}
	s.emit(ev)
	return nil
}
