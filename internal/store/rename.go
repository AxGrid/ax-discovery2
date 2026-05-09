package store

import (
	"encoding/json"
	"errors"
	"strings"
	"time"

	bolt "go.etcd.io/bbolt"

	"github.com/axgrid/discovery2/internal/model"
)

// RenameService atomically moves a Service and all its Instances to a new name.
// Fails with ErrConflict if newName already exists, ErrNotFound if the source
// is missing.
//
// Cross-bucket moves all happen in a single bbolt transaction so peers either
// see the old name or the new name, never both.
func (s *Store) RenameService(oldName, newName string) (*model.Service, error) {
	oldName = strings.TrimSpace(oldName)
	newName = strings.TrimSpace(newName)
	if oldName == "" || newName == "" {
		return nil, errors.New("names required")
	}
	if oldName == newName {
		return s.GetService(oldName)
	}

	var renamed model.Service
	var movedInstances []model.Instance

	err := s.db.Update(func(tx *bolt.Tx) error {
		bs := tx.Bucket(bktServices)
		bi := tx.Bucket(bktInstances)

		old := bs.Get([]byte(oldName))
		if old == nil {
			return ErrNotFound
		}
		if existing := bs.Get([]byte(newName)); existing != nil {
			return ErrConflict
		}

		var svc model.Service
		if err := json.Unmarshal(old, &svc); err != nil {
			return err
		}
		svc.Name = newName
		svc.UpdatedAt = time.Now().UTC()

		buf, err := json.Marshal(&svc)
		if err != nil {
			return err
		}
		if err := bs.Put([]byte(newName), buf); err != nil {
			return err
		}
		if err := bs.Delete([]byte(oldName)); err != nil {
			return err
		}
		renamed = svc

		// Move all instance keys from oldName/* to newName/*.
		c := bi.Cursor()
		prefix := []byte(oldName + "/")
		var oldKeys [][]byte
		for k, v := c.Seek(prefix); k != nil && hasPrefix(k, prefix); k, v = c.Next() {
			var inst model.Instance
			if err := json.Unmarshal(v, &inst); err != nil {
				return err
			}
			inst.ServiceName = newName
			inst.UpdatedAt = svc.UpdatedAt
			nb, err := json.Marshal(&inst)
			if err != nil {
				return err
			}
			if err := bi.Put(instanceKey(newName, inst.ID), nb); err != nil {
				return err
			}
			oldKeys = append(oldKeys, append([]byte(nil), k...))
			movedInstances = append(movedInstances, inst)
		}
		for _, k := range oldKeys {
			if err := bi.Delete(k); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}

	// Emit events: old service deleted, new service upserted, instances re-upserted.
	s.emit(model.Event{Type: model.EventServiceDeleted, Service: oldName})
	s.emit(model.Event{Type: model.EventServiceUpserted, Service: newName, Payload: &renamed})
	for i := range movedInstances {
		s.emit(model.Event{
			Type:     model.EventInstanceUpserted,
			Service:  newName,
			Instance: movedInstances[i].ID,
			Payload:  &movedInstances[i],
		})
	}
	return &renamed, nil
}
