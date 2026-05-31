package store

import (
	"encoding/json"
	"time"

	bolt "go.etcd.io/bbolt"

	"github.com/axgrid/discovery2/internal/model"
)

// Client tokens are stored keyed by the token secret itself so authentication
// is an O(1) lookup on the request hot path. Revoke-by-id scans (rare).

// PutClientToken creates or updates a client token.
func (s *Store) PutClientToken(t *model.ClientToken) error {
	now := time.Now().UTC()
	if t.CreatedAt.IsZero() {
		t.CreatedAt = now
	}
	t.UpdatedAt = now
	if err := s.putClientTokenRaw(t, model.Event{
		Type: model.EventTokenUpserted, Payload: t,
	}); err != nil {
		return err
	}
	return nil
}

// GetClientToken looks up a token by its secret (auth hot path).
func (s *Store) GetClientToken(token string) (*model.ClientToken, error) {
	var t model.ClientToken
	err := s.db.View(func(tx *bolt.Tx) error {
		v := tx.Bucket(bktClientTokens).Get([]byte(token))
		if v == nil {
			return ErrNotFound
		}
		return json.Unmarshal(v, &t)
	})
	if err != nil {
		return nil, err
	}
	return &t, nil
}

// ListClientTokens returns all tokens, newest first.
func (s *Store) ListClientTokens() ([]model.ClientToken, error) {
	var out []model.ClientToken
	err := s.db.View(func(tx *bolt.Tx) error {
		return tx.Bucket(bktClientTokens).ForEach(func(_, v []byte) error {
			var t model.ClientToken
			if err := json.Unmarshal(v, &t); err != nil {
				return nil
			}
			out = append(out, t)
			return nil
		})
	})
	if err != nil {
		return nil, err
	}
	for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
		out[i], out[j] = out[j], out[i]
	}
	return out, nil
}

// DeleteClientTokenByID revokes a token by its ID. Returns the deleted token so
// the caller can replicate the deletion (which is keyed by secret).
func (s *Store) DeleteClientTokenByID(id string) (*model.ClientToken, error) {
	var found *model.ClientToken
	err := s.db.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket(bktClientTokens)
		var key []byte
		_ = b.ForEach(func(k, v []byte) error {
			var t model.ClientToken
			if json.Unmarshal(v, &t) == nil && t.ID == id {
				cp := append([]byte(nil), k...)
				key = cp
				found = &t
			}
			return nil
		})
		if key == nil {
			return ErrNotFound
		}
		return b.Delete(key)
	})
	if err != nil {
		return nil, err
	}
	s.emit(model.Event{Type: model.EventTokenDeleted, Payload: found})
	return found, nil
}

// ListClientTokensRaw is the snapshot view.
func (s *Store) clientTokenSnapshot() ([]model.ClientToken, error) {
	return s.ListClientTokens()
}

// --- replication ---

func (s *Store) applyTokenRemote(ev model.Event) error {
	switch ev.Type {
	case model.EventTokenUpserted:
		var t model.ClientToken
		if err := remarshal(ev.Payload, &t); err != nil {
			return err
		}
		return s.putClientTokenRaw(&t, ev)
	case model.EventTokenDeleted:
		var t model.ClientToken
		if err := remarshal(ev.Payload, &t); err != nil {
			return err
		}
		return s.deleteClientTokenRaw(t.Token, ev)
	}
	return nil
}

func (s *Store) putClientTokenRaw(t *model.ClientToken, ev model.Event) error {
	err := s.db.Update(func(tx *bolt.Tx) error {
		// LWW on UpdatedAt for remote merges.
		if cur := tx.Bucket(bktClientTokens).Get([]byte(t.Token)); cur != nil {
			var ex model.ClientToken
			if json.Unmarshal(cur, &ex) == nil && ex.UpdatedAt.After(t.UpdatedAt) {
				return nil
			}
		}
		buf, err := json.Marshal(t)
		if err != nil {
			return err
		}
		return tx.Bucket(bktClientTokens).Put([]byte(t.Token), buf)
	})
	if err != nil {
		return err
	}
	s.emit(ev)
	return nil
}

func (s *Store) deleteClientTokenRaw(token string, ev model.Event) error {
	err := s.db.Update(func(tx *bolt.Tx) error {
		return tx.Bucket(bktClientTokens).Delete([]byte(token))
	})
	if err != nil {
		return err
	}
	s.emit(ev)
	return nil
}
