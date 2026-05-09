package store

import (
	"encoding/binary"
	"encoding/json"
	"time"

	"github.com/google/uuid"
	bolt "go.etcd.io/bbolt"

	"github.com/axgrid/discovery2/internal/model"
)

// AppendAudit writes one audit entry.
//
// Key layout: 8 bytes big-endian unix-nano timestamp + uuid bytes. This keeps
// the bucket sorted ascending by time, which makes "latest N" queries cheap
// via reverse cursor iteration.
func (s *Store) AppendAudit(entry model.AuditEntry) error {
	if entry.Timestamp.IsZero() {
		entry.Timestamp = time.Now().UTC()
	}
	if entry.ID == "" {
		entry.ID = uuid.NewString()
	}
	key := auditKey(entry.Timestamp, entry.ID)
	return s.db.Update(func(tx *bolt.Tx) error {
		buf, err := json.Marshal(&entry)
		if err != nil {
			return err
		}
		return tx.Bucket(bktAudit).Put(key, buf)
	})
}

// ListAudit returns the most recent N audit entries (newest first).
// If serviceFilter is non-empty, only entries whose Target matches are returned.
func (s *Store) ListAudit(limit int, serviceFilter string) ([]model.AuditEntry, error) {
	if limit <= 0 || limit > 1000 {
		limit = 200
	}
	var out []model.AuditEntry
	err := s.db.View(func(tx *bolt.Tx) error {
		c := tx.Bucket(bktAudit).Cursor()
		for k, v := c.Last(); k != nil && len(out) < limit; k, v = c.Prev() {
			var e model.AuditEntry
			if err := json.Unmarshal(v, &e); err != nil {
				continue
			}
			if serviceFilter != "" && e.Target != serviceFilter {
				continue
			}
			out = append(out, e)
		}
		return nil
	})
	return out, err
}

func auditKey(ts time.Time, id string) []byte {
	buf := make([]byte, 8+1+len(id))
	binary.BigEndian.PutUint64(buf[:8], uint64(ts.UTC().UnixNano()))
	buf[8] = '/'
	copy(buf[9:], id)
	return buf
}
