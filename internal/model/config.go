package model

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

// VarType tags the concrete type of a config value so the UI can render the
// right editor and clients can decode without guessing.
type VarType string

const (
	VarString VarType = "string"
	VarInt    VarType = "int"
	VarFloat  VarType = "float"
	VarBool   VarType = "bool"
	VarJSON   VarType = "json"  // any valid JSON (object/array/scalar)
	VarBytes  VarType = "bytes" // base64-encoded string on the wire
)

// TypedValue is one config value: its declared type plus the raw JSON encoding
// of the value (a base64 string for bytes). Keeping Value as RawMessage means we
// validate-and-store without lossy round-trips through interface{}.
type TypedValue struct {
	Type  VarType         `json:"type"`
	Value json.RawMessage `json:"value"`
}

// maxValueBytes caps a single value's encoded size — config is operator data,
// not a blob store; this keeps gossip/snapshot payloads sane.
const maxValueBytes = 1 << 20 // 1 MiB

// Validate checks that Value is well-formed for Type.
func (v TypedValue) Validate() error {
	if len(v.Value) > maxValueBytes {
		return fmt.Errorf("value too large (%d bytes, max %d)", len(v.Value), maxValueBytes)
	}
	switch v.Type {
	case VarString:
		var s string
		if err := json.Unmarshal(v.Value, &s); err != nil {
			return errors.New("string value must be a JSON string")
		}
	case VarInt:
		var i int64
		if err := json.Unmarshal(v.Value, &i); err != nil {
			return errors.New("int value must be a whole number")
		}
	case VarFloat:
		var f float64
		if err := json.Unmarshal(v.Value, &f); err != nil {
			return errors.New("float value must be a number")
		}
	case VarBool:
		var b bool
		if err := json.Unmarshal(v.Value, &b); err != nil {
			return errors.New("bool value must be true or false")
		}
	case VarJSON:
		if !json.Valid(v.Value) {
			return errors.New("json value must be valid JSON")
		}
	case VarBytes:
		var s string
		if err := json.Unmarshal(v.Value, &s); err != nil {
			return errors.New("bytes value must be a base64 JSON string")
		}
		if _, err := base64.StdEncoding.DecodeString(s); err != nil {
			return errors.New("bytes value must be valid base64")
		}
	default:
		return fmt.Errorf("unknown var type %q", v.Type)
	}
	return nil
}

// Config scope kinds.
const (
	ScopeGlobal  = "global"
	ScopeService = "service"
	ScopeVersion = "version"
)

// ConfigScope identifies one config container: the global tree, a service's
// config, or a version-constrained block within a service.
type ConfigScope struct {
	Kind       string `json:"kind"`                 // global | service | version
	Service    string `json:"service,omitempty"`    // service / version scopes
	Constraint string `json:"constraint,omitempty"` // version scope only, e.g. ">=2.1.0"
}

// ID is the stable storage/UI key for a scope. It's opaque — never parse a
// scope back out of it; the ConfigScope is always carried alongside.
func (s ConfigScope) ID() string {
	switch s.Kind {
	case ScopeGlobal:
		return "global"
	case ScopeService:
		return "service:" + s.Service
	case ScopeVersion:
		return "version:" + s.Service + ":" + s.Constraint
	default:
		return s.Kind + ":" + s.Service + ":" + s.Constraint
	}
}

// Validate normalises and sanity-checks a scope.
func (s *ConfigScope) Validate() error {
	s.Kind = strings.TrimSpace(s.Kind)
	s.Service = strings.TrimSpace(s.Service)
	s.Constraint = strings.TrimSpace(s.Constraint)
	switch s.Kind {
	case ScopeGlobal:
		s.Service, s.Constraint = "", ""
	case ScopeService:
		if s.Service == "" {
			return errors.New("service scope requires a service name")
		}
		s.Constraint = ""
	case ScopeVersion:
		if s.Service == "" {
			return errors.New("version scope requires a service name")
		}
		if s.Constraint == "" {
			return errors.New("version scope requires a constraint")
		}
	default:
		return fmt.Errorf("unknown scope kind %q", s.Kind)
	}
	return nil
}

// ConfigRevision is one applied snapshot of a scope's full variable set. The
// active revision is what clients read; older ones live in history for rollback.
type ConfigRevision struct {
	Scope     ConfigScope           `json:"scope"`
	Revision  int                   `json:"revision"`
	Vars      map[string]TypedValue `json:"vars"`
	Note      string                `json:"note,omitempty"`
	Author    string                `json:"author,omitempty"`
	CreatedAt time.Time             `json:"createdAt"`
	UpdatedAt time.Time             `json:"updatedAt"` // drives last-write-wins replication
}

// ConfigDraft is an unpublished working set for a scope — saved so edits aren't
// lost and other operators/nodes see the pending block. Apply turns it into a
// new ConfigRevision; it does not have to exist to Apply (you can apply a block
// directly).
type ConfigDraft struct {
	Scope        ConfigScope           `json:"scope"`
	Vars         map[string]TypedValue `json:"vars"`
	BaseRevision int                   `json:"baseRevision"`
	Author       string                `json:"author,omitempty"`
	UpdatedAt    time.Time             `json:"updatedAt"`
}

// ResolvedConfig is the merged effective config for a (service, version),
// with optional provenance describing which scope each key came from.
type ResolvedConfig struct {
	Service    string                `json:"service"`
	Version    string                `json:"version,omitempty"`
	Vars       map[string]TypedValue `json:"vars"`
	Provenance map[string]string     `json:"provenance,omitempty"` // key -> scope ID that won
}

// Config event types (replicated like service/instance events).
const (
	EventConfigApplied      = "config.applied"
	EventConfigDraftSaved   = "config.draft.saved"
	EventConfigDraftDeleted = "config.draft.deleted"
	EventConfigDeleted      = "config.deleted"
)

// Config audit actions.
const (
	AuditConfigApplied        = "config.applied"
	AuditConfigRolledBack     = "config.rolledback"
	AuditConfigDraftSaved     = "config.draft.saved"
	AuditConfigDraftDiscarded = "config.draft.discarded"
	AuditConfigDeleted        = "config.deleted"
)
