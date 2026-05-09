package store

import (
	"encoding/json"
	"time"

	bolt "go.etcd.io/bbolt"

	"github.com/axgrid/discovery2/internal/model"
)

// PutSession stores a session keyed by its token.
func (s *Store) PutSession(sess *model.Session) error {
	if sess.CreatedAt.IsZero() {
		sess.CreatedAt = time.Now().UTC()
	}
	return s.db.Update(func(tx *bolt.Tx) error {
		buf, err := json.Marshal(sess)
		if err != nil {
			return err
		}
		return tx.Bucket(bktSessions).Put([]byte(sess.Token), buf)
	})
}

// GetSession returns a session by token, transparently expiring stale ones.
func (s *Store) GetSession(token string) (*model.Session, error) {
	var sess model.Session
	err := s.db.View(func(tx *bolt.Tx) error {
		v := tx.Bucket(bktSessions).Get([]byte(token))
		if v == nil {
			return ErrNotFound
		}
		return json.Unmarshal(v, &sess)
	})
	if err != nil {
		return nil, err
	}
	if !sess.ExpiresAt.IsZero() && sess.ExpiresAt.Before(time.Now()) {
		_ = s.DeleteSession(token)
		return nil, ErrNotFound
	}
	sess.Token = token
	return &sess, nil
}

func (s *Store) DeleteSession(token string) error {
	return s.db.Update(func(tx *bolt.Tx) error {
		return tx.Bucket(bktSessions).Delete([]byte(token))
	})
}

// SweepExpiredSessions removes any session past its ExpiresAt. Cheap, safe to
// call periodically.
func (s *Store) SweepExpiredSessions() (int, error) {
	now := time.Now()
	var keys [][]byte
	err := s.db.View(func(tx *bolt.Tx) error {
		return tx.Bucket(bktSessions).ForEach(func(k, v []byte) error {
			var sess model.Session
			if err := json.Unmarshal(v, &sess); err != nil {
				return nil
			}
			if !sess.ExpiresAt.IsZero() && sess.ExpiresAt.Before(now) {
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
		b := tx.Bucket(bktSessions)
		for _, k := range keys {
			_ = b.Delete(k)
		}
		return nil
	})
	return len(keys), err
}
