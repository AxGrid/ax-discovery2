package store

import (
	"encoding/json"
	"errors"
	"strings"
	"time"

	bolt "go.etcd.io/bbolt"

	"github.com/axgrid/discovery2/internal/model"
)

// PutUser creates or updates a user. Username uniqueness is enforced via the
// users_by_name index.
func (s *Store) PutUser(u *model.User) error {
	u.Username = strings.TrimSpace(u.Username)
	if u.Username == "" {
		return errors.New("username required")
	}
	if u.ID == "" {
		return errors.New("user ID required")
	}
	now := time.Now().UTC()
	if u.CreatedAt.IsZero() {
		u.CreatedAt = now
	}
	u.UpdatedAt = now

	err := s.db.Update(func(tx *bolt.Tx) error {
		bIdx := tx.Bucket(bktUsersByName)
		bUsers := tx.Bucket(bktUsers)

		// Username uniqueness: if the index points at a different ID, reject.
		if existingID := bIdx.Get([]byte(u.Username)); existingID != nil && string(existingID) != u.ID {
			return ErrConflict
		}

		// If updating, drop the old name → id index entry if username changed.
		if old := bUsers.Get([]byte(u.ID)); old != nil {
			var prev model.User
			if err := json.Unmarshal(old, &prev); err == nil && prev.Username != u.Username {
				_ = bIdx.Delete([]byte(prev.Username))
			}
			// preserve CreatedAt
			if prev.CreatedAt.Before(u.CreatedAt) {
				u.CreatedAt = prev.CreatedAt
			}
			// preserve password hash if caller didn't set one (e.g. profile edit)
			if u.PasswordHash == "" {
				u.PasswordHash = prev.PasswordHash
			}
		}

		buf, err := json.Marshal(u)
		if err != nil {
			return err
		}
		if err := bUsers.Put([]byte(u.ID), buf); err != nil {
			return err
		}
		return bIdx.Put([]byte(u.Username), []byte(u.ID))
	})
	if err != nil {
		return err
	}
	s.emit(model.Event{Type: model.EventUserUpserted, Payload: redactedUser(u)})
	return nil
}

func (s *Store) GetUser(id string) (*model.User, error) {
	var u model.User
	err := s.db.View(func(tx *bolt.Tx) error {
		v := tx.Bucket(bktUsers).Get([]byte(id))
		if v == nil {
			return ErrNotFound
		}
		return json.Unmarshal(v, &u)
	})
	if err != nil {
		return nil, err
	}
	return &u, nil
}

func (s *Store) GetUserByUsername(username string) (*model.User, error) {
	username = strings.TrimSpace(username)
	var u model.User
	err := s.db.View(func(tx *bolt.Tx) error {
		id := tx.Bucket(bktUsersByName).Get([]byte(username))
		if id == nil {
			return ErrNotFound
		}
		v := tx.Bucket(bktUsers).Get(id)
		if v == nil {
			return ErrNotFound
		}
		return json.Unmarshal(v, &u)
	})
	if err != nil {
		return nil, err
	}
	return &u, nil
}

func (s *Store) ListUsers() ([]model.User, error) {
	var out []model.User
	err := s.db.View(func(tx *bolt.Tx) error {
		return tx.Bucket(bktUsers).ForEach(func(_, v []byte) error {
			var u model.User
			if err := json.Unmarshal(v, &u); err != nil {
				return err
			}
			out = append(out, u)
			return nil
		})
	})
	return out, err
}

func (s *Store) DeleteUser(id string) error {
	var existed *model.User
	err := s.db.Update(func(tx *bolt.Tx) error {
		bUsers := tx.Bucket(bktUsers)
		v := bUsers.Get([]byte(id))
		if v == nil {
			return ErrNotFound
		}
		var u model.User
		if err := json.Unmarshal(v, &u); err != nil {
			return err
		}
		existed = &u
		if err := bUsers.Delete([]byte(id)); err != nil {
			return err
		}
		_ = tx.Bucket(bktUsersByName).Delete([]byte(u.Username))

		// Cascade-cleanup: drop sessions for this user.
		bSess := tx.Bucket(bktSessions)
		c := bSess.Cursor()
		var toDelete [][]byte
		for k, sv := c.First(); k != nil; k, sv = c.Next() {
			var sess model.Session
			if err := json.Unmarshal(sv, &sess); err == nil && sess.UserID == id {
				cp := append([]byte(nil), k...)
				toDelete = append(toDelete, cp)
			}
		}
		for _, k := range toDelete {
			_ = bSess.Delete(k)
		}
		return nil
	})
	if err != nil {
		return err
	}
	if existed != nil {
		s.emit(model.Event{Type: model.EventUserDeleted, Payload: redactedUser(existed)})
	}
	return nil
}

// CountUsers returns how many users exist; used during bootstrap to decide
// whether to create the default admin.
func (s *Store) CountUsers() (int, error) {
	n := 0
	err := s.db.View(func(tx *bolt.Tx) error {
		return tx.Bucket(bktUsers).ForEach(func(_, _ []byte) error {
			n++
			return nil
		})
	})
	return n, err
}

func redactedUser(u *model.User) *model.User {
	cp := *u
	cp.PasswordHash = ""
	return &cp
}
