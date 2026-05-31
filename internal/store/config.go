package store

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"

	bolt "go.etcd.io/bbolt"

	"github.com/axgrid/discovery2/internal/model"
	"github.com/axgrid/discovery2/internal/semver"
)

func hashVars(vars map[string]model.TypedValue) map[string]string {
	out := make(map[string]string, len(vars))
	for k, v := range vars {
		out[k] = model.HashValue(v)
	}
	return out
}

// configETag hashes the sorted (key, per-var hash) pairs of a resolved set —
// cheap, never touches the (possibly large) values themselves.
func configETag(vars map[string]model.TypedValue, winHash map[string]string) string {
	keys := make([]string, 0, len(vars))
	for k := range vars {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	h := sha256.New()
	for _, k := range keys {
		hash := winHash[k]
		if hash == "" {
			hash = model.HashValue(vars[k])
		}
		h.Write([]byte(k))
		h.Write([]byte{0})
		h.Write([]byte(hash))
		h.Write([]byte{0})
	}
	return hex.EncodeToString(h.Sum(nil))
}

// Config storage layout in the bktConfig bucket (all keys are byte strings):
//
//	active/<scopeID>        -> ConfigRevision   (the published revision clients read)
//	rev/<scopeID>/<NNNN>    -> ConfigRevision   (history, NNNN zero-padded for order)
//	draft/<scopeID>         -> ConfigDraft      (unpublished working set, optional)
//
// scopeID is ConfigScope.ID() — opaque; the ConfigScope is always embedded in
// the stored value, so we never parse it back out of a key.

const revPad = 10 // zero-pad width for revision numbers in history keys

func cfgActiveKey(id string) []byte { return []byte("active/" + id) }
func cfgDraftKey(id string) []byte  { return []byte("draft/" + id) }
func cfgRevPrefix(id string) []byte { return []byte("rev/" + id + "/") }
func cfgRevKey(id string, n int) []byte {
	return []byte(fmt.Sprintf("rev/%s/%0*d", id, revPad, n))
}

// ConfigScopeSummary is a lightweight row for the UI scope list.
type ConfigScopeSummary struct {
	Scope     model.ConfigScope `json:"scope"`
	Revision  int               `json:"revision"`
	VarCount  int               `json:"varCount"`
	HasDraft  bool              `json:"hasDraft"`
	UpdatedAt time.Time         `json:"updatedAt"`
}

// --- read ---

// GetActiveConfig returns the published revision for a scope, or ErrNotFound.
func (s *Store) GetActiveConfig(scope model.ConfigScope) (*model.ConfigRevision, error) {
	var rev model.ConfigRevision
	err := s.db.View(func(tx *bolt.Tx) error {
		v := tx.Bucket(bktConfig).Get(cfgActiveKey(scope.ID()))
		if v == nil {
			return ErrNotFound
		}
		return json.Unmarshal(v, &rev)
	})
	if err != nil {
		return nil, err
	}
	return &rev, nil
}

// ConfigHistory returns all stored revisions for a scope, newest first.
func (s *Store) ConfigHistory(scope model.ConfigScope) ([]model.ConfigRevision, error) {
	var out []model.ConfigRevision
	prefix := cfgRevPrefix(scope.ID())
	err := s.db.View(func(tx *bolt.Tx) error {
		c := tx.Bucket(bktConfig).Cursor()
		for k, v := c.Seek(prefix); k != nil && hasPrefix(k, prefix); k, v = c.Next() {
			var rev model.ConfigRevision
			if err := json.Unmarshal(v, &rev); err != nil {
				return err
			}
			out = append(out, rev)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Revision > out[j].Revision })
	return out, nil
}

// GetDraft returns a scope's unpublished draft, or ErrNotFound.
func (s *Store) GetDraft(scope model.ConfigScope) (*model.ConfigDraft, error) {
	var d model.ConfigDraft
	err := s.db.View(func(tx *bolt.Tx) error {
		v := tx.Bucket(bktConfig).Get(cfgDraftKey(scope.ID()))
		if v == nil {
			return ErrNotFound
		}
		return json.Unmarshal(v, &d)
	})
	if err != nil {
		return nil, err
	}
	return &d, nil
}

// ListConfigScopes summarises every scope that has a published revision.
func (s *Store) ListConfigScopes() ([]ConfigScopeSummary, error) {
	var out []ConfigScopeSummary
	prefix := []byte("active/")
	err := s.db.View(func(tx *bolt.Tx) error {
		b := tx.Bucket(bktConfig)
		c := b.Cursor()
		for k, v := c.Seek(prefix); k != nil && hasPrefix(k, prefix); k, v = c.Next() {
			var rev model.ConfigRevision
			if err := json.Unmarshal(v, &rev); err != nil {
				return err
			}
			hasDraft := b.Get(cfgDraftKey(rev.Scope.ID())) != nil
			out = append(out, ConfigScopeSummary{
				Scope: rev.Scope, Revision: rev.Revision,
				VarCount: len(rev.Vars), HasDraft: hasDraft, UpdatedAt: rev.UpdatedAt,
			})
		}
		return nil
	})
	return out, err
}

// --- write ---

// ApplyConfig publishes vars as a new revision of a scope (atomic block
// replace). It allocates the next revision number, records history, and clears
// any draft. validateVars must have passed at the handler layer.
func (s *Store) ApplyConfig(scope model.ConfigScope, vars map[string]model.TypedValue, note, author string) (*model.ConfigRevision, error) {
	if err := scope.Validate(); err != nil {
		return nil, err
	}
	if vars == nil {
		vars = map[string]model.TypedValue{}
	}
	now := time.Now().UTC()
	var rev model.ConfigRevision
	err := s.db.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket(bktConfig)
		id := scope.ID()
		next := 1
		if cur := b.Get(cfgActiveKey(id)); cur != nil {
			var prev model.ConfigRevision
			if err := json.Unmarshal(cur, &prev); err == nil {
				next = prev.Revision + 1
			}
		}
		rev = model.ConfigRevision{
			Scope: scope, Revision: next, Vars: vars, Hashes: hashVars(vars),
			Note: note, Author: author, CreatedAt: now, UpdatedAt: now,
		}
		buf, err := json.Marshal(&rev)
		if err != nil {
			return err
		}
		if err := b.Put(cfgActiveKey(id), buf); err != nil {
			return err
		}
		if err := b.Put(cfgRevKey(id, next), buf); err != nil {
			return err
		}
		return b.Delete(cfgDraftKey(id))
	})
	if err != nil {
		return nil, err
	}
	s.emit(model.Event{Type: model.EventConfigApplied, Service: scope.Service, Payload: &rev})
	return &rev, nil
}

// RollbackConfig republishes a past revision's vars as a new revision.
func (s *Store) RollbackConfig(scope model.ConfigScope, revision int, author string) (*model.ConfigRevision, error) {
	var target model.ConfigRevision
	err := s.db.View(func(tx *bolt.Tx) error {
		v := tx.Bucket(bktConfig).Get(cfgRevKey(scope.ID(), revision))
		if v == nil {
			return ErrNotFound
		}
		return json.Unmarshal(v, &target)
	})
	if err != nil {
		return nil, err
	}
	return s.ApplyConfig(scope, target.Vars, fmt.Sprintf("rollback to revision %d", revision), author)
}

// PutDraft saves (or replaces) a scope's draft without publishing it.
func (s *Store) PutDraft(scope model.ConfigScope, vars map[string]model.TypedValue, author string) (*model.ConfigDraft, error) {
	if err := scope.Validate(); err != nil {
		return nil, err
	}
	if vars == nil {
		vars = map[string]model.TypedValue{}
	}
	now := time.Now().UTC()
	d := model.ConfigDraft{Scope: scope, Vars: vars, Author: author, UpdatedAt: now}
	err := s.db.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket(bktConfig)
		if cur := b.Get(cfgActiveKey(scope.ID())); cur != nil {
			var prev model.ConfigRevision
			if json.Unmarshal(cur, &prev) == nil {
				d.BaseRevision = prev.Revision
			}
		}
		buf, err := json.Marshal(&d)
		if err != nil {
			return err
		}
		return b.Put(cfgDraftKey(scope.ID()), buf)
	})
	if err != nil {
		return nil, err
	}
	s.emit(model.Event{Type: model.EventConfigDraftSaved, Service: scope.Service, Payload: &d})
	return &d, nil
}

// DeleteDraft discards a scope's draft.
func (s *Store) DeleteDraft(scope model.ConfigScope) error {
	err := s.db.Update(func(tx *bolt.Tx) error {
		return tx.Bucket(bktConfig).Delete(cfgDraftKey(scope.ID()))
	})
	if err != nil {
		return err
	}
	s.emit(model.Event{Type: model.EventConfigDraftDeleted, Service: scope.Service, Payload: &scope})
	return nil
}

// DeleteConfigScope removes a scope entirely: active, all history, and draft.
func (s *Store) DeleteConfigScope(scope model.ConfigScope) error {
	id := scope.ID()
	err := s.db.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket(bktConfig)
		if err := b.Delete(cfgActiveKey(id)); err != nil {
			return err
		}
		if err := b.Delete(cfgDraftKey(id)); err != nil {
			return err
		}
		c := b.Cursor()
		prefix := cfgRevPrefix(id)
		var keys [][]byte
		for k, _ := c.Seek(prefix); k != nil && hasPrefix(k, prefix); k, _ = c.Next() {
			keys = append(keys, append([]byte(nil), k...))
		}
		for _, k := range keys {
			if err := b.Delete(k); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return err
	}
	s.emit(model.Event{Type: model.EventConfigDeleted, Service: scope.Service, Payload: &scope})
	return nil
}

// --- resolution (global < service < version) ---

// ResolveConfig merges the active revisions of global, the service scope, and
// every matching version block into one effective map. Among version blocks
// that match `version`, the one with the higher constraint floor wins (so
// ">=2.1.0" overrides ">=2.0.0" for a 2.1.0 instance). prefixes/keys, when
// supplied, restrict the returned keys (prefix match OR exact key).
func (s *Store) ResolveConfig(service, version string, prefixes, keys []string) (*model.ResolvedConfig, error) {
	out := map[string]model.TypedValue{}
	prov := map[string]string{}
	winHash := map[string]string{}
	overlay := func(scope model.ConfigScope) {
		rev, err := s.GetActiveConfig(scope)
		if err != nil {
			return
		}
		for k, v := range rev.Vars {
			out[k] = v
			prov[k] = scope.ID()
			if rev.Hashes != nil {
				winHash[k] = rev.Hashes[k]
			} else {
				winHash[k] = model.HashValue(v)
			}
		}
	}

	overlay(model.ConfigScope{Kind: model.ScopeGlobal})
	if service != "" {
		overlay(model.ConfigScope{Kind: model.ScopeService, Service: service})
	}
	if service != "" && version != "" {
		blocks, err := s.versionScopes(service)
		if err != nil {
			return nil, err
		}
		matching := blocks[:0:0]
		for _, sc := range blocks {
			if ok, _ := semver.Match(version, sc.Constraint); ok {
				matching = append(matching, sc)
			}
		}
		sort.Slice(matching, func(i, j int) bool {
			fi, fj := semver.Floor(matching[i].Constraint), semver.Floor(matching[j].Constraint)
			if c := semver.Compare(fi, fj); c != 0 {
				return c < 0 // lower floor first → higher floor overlays last (wins)
			}
			return matching[i].Constraint < matching[j].Constraint
		})
		for _, sc := range matching {
			overlay(sc)
		}
	}

	if len(prefixes) > 0 || len(keys) > 0 {
		out, prov = filterConfig(out, prov, prefixes, keys)
	}
	return &model.ResolvedConfig{
		Service: service, Version: version, Vars: out, Provenance: prov,
		ETag: configETag(out, winHash),
	}, nil
}

// versionScopes lists every version-scope of a service that has a published revision.
func (s *Store) versionScopes(service string) ([]model.ConfigScope, error) {
	var out []model.ConfigScope
	prefix := []byte("active/")
	err := s.db.View(func(tx *bolt.Tx) error {
		c := tx.Bucket(bktConfig).Cursor()
		for k, v := c.Seek(prefix); k != nil && hasPrefix(k, prefix); k, v = c.Next() {
			var rev model.ConfigRevision
			if err := json.Unmarshal(v, &rev); err != nil {
				return err
			}
			if rev.Scope.Kind == model.ScopeVersion && rev.Scope.Service == service {
				out = append(out, rev.Scope)
			}
		}
		return nil
	})
	return out, err
}

func filterConfig(in map[string]model.TypedValue, prov map[string]string, prefixes, keys []string) (map[string]model.TypedValue, map[string]string) {
	keep := func(k string) bool {
		for _, key := range keys {
			if k == key {
				return true
			}
		}
		for _, p := range prefixes {
			if strings.HasPrefix(k, p) {
				return true
			}
		}
		return false
	}
	outV := map[string]model.TypedValue{}
	outP := map[string]string{}
	for k, v := range in {
		if keep(k) {
			outV[k] = v
			outP[k] = prov[k]
		}
	}
	return outV, outP
}

// --- cluster replication ---

// applyConfigRemote merges a remote config event. config.applied stores the
// revision in history and advances active when it's newer; draft/delete events
// mirror their local counterparts. All paths re-emit (with the remote OriginID
// intact, so the cluster loop won't re-broadcast).
func (s *Store) applyConfigRemote(ev model.Event) error {
	switch ev.Type {
	case model.EventConfigApplied:
		var rev model.ConfigRevision
		if err := remarshal(ev.Payload, &rev); err != nil {
			return err
		}
		return s.putConfigRevisionRaw(&rev, ev)
	case model.EventConfigDraftSaved:
		var d model.ConfigDraft
		if err := remarshal(ev.Payload, &d); err != nil {
			return err
		}
		return s.putDraftRaw(&d, ev)
	case model.EventConfigDraftDeleted:
		var sc model.ConfigScope
		if err := remarshal(ev.Payload, &sc); err != nil {
			return err
		}
		return s.deleteDraftRaw(sc, ev)
	case model.EventConfigDeleted:
		var sc model.ConfigScope
		if err := remarshal(ev.Payload, &sc); err != nil {
			return err
		}
		return s.deleteConfigScopeRaw(sc, ev)
	}
	return nil
}

func (s *Store) putConfigRevisionRaw(rev *model.ConfigRevision, ev model.Event) error {
	id := rev.Scope.ID()
	err := s.db.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket(bktConfig)
		buf, err := json.Marshal(rev)
		if err != nil {
			return err
		}
		// History: store unless an equal-or-newer revision blob already exists.
		if cur := b.Get(cfgRevKey(id, rev.Revision)); cur != nil {
			var ex model.ConfigRevision
			if json.Unmarshal(cur, &ex) == nil && ex.UpdatedAt.After(rev.UpdatedAt) {
				return nil
			}
		}
		if err := b.Put(cfgRevKey(id, rev.Revision), buf); err != nil {
			return err
		}
		// Active: advance when this revision is newer (higher number, or same
		// number with a later timestamp — conflict tiebreak).
		advance := true
		if cur := b.Get(cfgActiveKey(id)); cur != nil {
			var act model.ConfigRevision
			if json.Unmarshal(cur, &act) == nil {
				advance = rev.Revision > act.Revision ||
					(rev.Revision == act.Revision && rev.UpdatedAt.After(act.UpdatedAt))
			}
		}
		if advance {
			return b.Put(cfgActiveKey(id), buf)
		}
		return nil
	})
	if err != nil {
		return err
	}
	s.emit(ev)
	return nil
}

func (s *Store) putDraftRaw(d *model.ConfigDraft, ev model.Event) error {
	err := s.db.Update(func(tx *bolt.Tx) error {
		buf, err := json.Marshal(d)
		if err != nil {
			return err
		}
		return tx.Bucket(bktConfig).Put(cfgDraftKey(d.Scope.ID()), buf)
	})
	if err != nil {
		return err
	}
	s.emit(ev)
	return nil
}

func (s *Store) deleteDraftRaw(scope model.ConfigScope, ev model.Event) error {
	err := s.db.Update(func(tx *bolt.Tx) error {
		return tx.Bucket(bktConfig).Delete(cfgDraftKey(scope.ID()))
	})
	if err != nil {
		return err
	}
	s.emit(ev)
	return nil
}

func (s *Store) deleteConfigScopeRaw(scope model.ConfigScope, ev model.Event) error {
	id := scope.ID()
	err := s.db.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket(bktConfig)
		if err := b.Delete(cfgActiveKey(id)); err != nil {
			return err
		}
		if err := b.Delete(cfgDraftKey(id)); err != nil {
			return err
		}
		c := b.Cursor()
		prefix := cfgRevPrefix(id)
		var keys [][]byte
		for k, _ := c.Seek(prefix); k != nil && hasPrefix(k, prefix); k, _ = c.Next() {
			keys = append(keys, append([]byte(nil), k...))
		}
		for _, k := range keys {
			if err := b.Delete(k); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return err
	}
	s.emit(ev)
	return nil
}

// configSnapshot returns every revision + draft for anti-entropy.
func (s *Store) configSnapshot() (revs []model.ConfigRevision, drafts []model.ConfigDraft, err error) {
	err = s.db.View(func(tx *bolt.Tx) error {
		b := tx.Bucket(bktConfig)
		c := b.Cursor()
		revPrefix := []byte("rev/")
		for k, v := c.Seek(revPrefix); k != nil && hasPrefix(k, revPrefix); k, v = c.Next() {
			var rev model.ConfigRevision
			if json.Unmarshal(v, &rev) == nil {
				revs = append(revs, rev)
			}
		}
		draftPrefix := []byte("draft/")
		for k, v := c.Seek(draftPrefix); k != nil && hasPrefix(k, draftPrefix); k, v = c.Next() {
			var d model.ConfigDraft
			if json.Unmarshal(v, &d) == nil {
				drafts = append(drafts, d)
			}
		}
		return nil
	})
	return revs, drafts, err
}
