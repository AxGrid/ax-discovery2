package model

import (
	"errors"
	"strings"
	"time"
)

// Visibility controls who can edit a Service. All visibility levels are
// readable by everyone — discovery only restricts modification.
type Visibility string

const (
	VisibilityPublic  Visibility = "public"  // anyone authenticated can edit
	VisibilityPrivate Visibility = "private" // only OwnerID, admins, and Grants can edit
)

// Service is a logical service registered in discovery.
// Concrete running processes are represented by Instances.
type Service struct {
	Name        string            `json:"name"`
	Description string            `json:"description,omitempty"`
	Tags        []string          `json:"tags,omitempty"`
	Metadata    map[string]string `json:"metadata,omitempty"`

	// Access control. Visibility defaults to "public" for back-compat.
	Visibility Visibility `json:"visibility,omitempty"`
	OwnerID    string     `json:"ownerId,omitempty"` // user ID; "" = system / no owner
	Grants     []string   `json:"grants,omitempty"`  // user IDs that may edit a private service

	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// CanEdit returns true if the given user (and admin flag) is allowed to mutate
// this service. system==true means a static-token request, which always passes.
func (s *Service) CanEdit(userID string, isAdmin, system bool) bool {
	if system || isAdmin {
		return true
	}
	if s.Visibility == "" || s.Visibility == VisibilityPublic {
		// authenticated users can edit public services
		return userID != ""
	}
	// private
	if s.OwnerID != "" && s.OwnerID == userID {
		return true
	}
	for _, g := range s.Grants {
		if g == userID {
			return true
		}
	}
	return false
}

// Interface is one network endpoint exposed by an instance,
// e.g. {Name:"WEB", Protocol:"http", Port:8080}.
type Interface struct {
	Name      string            `json:"name"`
	Protocol  string            `json:"protocol"`
	Port      int               `json:"port"`
	Path      string            `json:"path,omitempty"`
	TLS       bool              `json:"tls,omitempty"`
	HealthURL string            `json:"healthUrl,omitempty"`
	Metadata  map[string]string `json:"metadata,omitempty"`
}

type Status string

const (
	StatusUp       Status = "up"
	StatusDown     Status = "down"
	StatusStarting Status = "starting"
	StatusDraining Status = "draining"
)

// CheckMode controls how an instance's liveness is determined.
type CheckMode string

const (
	// CheckHeartbeat — the instance is responsible for sending heartbeats; the
	// server marks it down when LastHeartbeat is older than TTLSeconds.
	// This is the default when CheckMode is unset.
	CheckHeartbeat CheckMode = "heartbeat"

	// CheckHTTP — discovery actively probes one of the instance's HTTP/HTTPS
	// interfaces (using HealthURL or Path). Heartbeats are not required.
	CheckHTTP CheckMode = "http"

	// CheckTCP — discovery opens a TCP connection to the first interface's
	// port. Heartbeats are not required.
	CheckTCP CheckMode = "tcp"

	// CheckNone — discovery never changes this instance's status automatically.
	CheckNone CheckMode = "none"
)

// ProbeResult is the outcome of probing one interface.
type ProbeResult struct {
	Interface  string `json:"interface"`
	URL        string `json:"url,omitempty"`
	OK         bool   `json:"ok"`
	HTTPStatus int    `json:"httpStatus,omitempty"`
	Error      string `json:"error,omitempty"`
	LatencyMS  int64  `json:"latencyMs"`
}

// InstanceCheck is the most recent probe outcome for an instance, including
// per-interface details. UI uses this to colour DOWN interfaces; backend uses
// the OK flag to decide whether the instance status should flip.
type InstanceCheck struct {
	Timestamp time.Time     `json:"timestamp"`
	OK        bool          `json:"ok"`
	Mode      CheckMode     `json:"mode,omitempty"`
	Results   []ProbeResult `json:"results,omitempty"`
}

// Instance is a single running process registered for a Service.
type Instance struct {
	ID            string            `json:"id"`
	ServiceName   string            `json:"service"`
	Address       string            `json:"address"`
	Interfaces    []Interface       `json:"interfaces"`
	Weight        int               `json:"weight"`
	Status        Status            `json:"status"`
	Metadata      map[string]string `json:"metadata,omitempty"`
	TTLSeconds    int               `json:"ttlSeconds"`

	// Managed marks an instance as self-registered by a client library
	// (discovery2-client.Register sets it to true). UI sessions cannot
	// edit or delete a managed instance — only the system identity that
	// owns it (i.e. the same client coming back with a fresh PUT, or an
	// admin using a static token) can. This protects the cluster from an
	// operator accidentally changing fields the client will overwrite on
	// its next restart.
	Managed bool `json:"managed,omitempty"`

	// Liveness configuration.
	CheckMode        CheckMode `json:"checkMode,omitempty"`
	CheckIntervalSec int       `json:"checkIntervalSec,omitempty"`

	// LastCheck is the most recent probe outcome (http/tcp modes). Updated by
	// the local node's health checker; replicated only when an event fires for
	// this instance from this node (i.e. on status flips). Peers' LastCheck
	// reflects the last time *some* node observed the instance, not strictly
	// the local node's view — that's acceptable since each node also probes.
	LastCheck *InstanceCheck `json:"lastCheck,omitempty"`

	LastHeartbeat time.Time `json:"lastHeartbeat"`
	RegisteredAt  time.Time `json:"registeredAt"`
	UpdatedAt     time.Time `json:"updatedAt"`
}

// EffectiveCheckMode returns Mode with the heartbeat default applied.
func (i *Instance) EffectiveCheckMode() CheckMode {
	if i.CheckMode == "" {
		return CheckHeartbeat
	}
	return i.CheckMode
}

// Expired reports whether the instance has not heartbeated within its TTL.
// Only meaningful when EffectiveCheckMode == CheckHeartbeat.
func (i *Instance) Expired(now time.Time) bool {
	if i.TTLSeconds <= 0 {
		return false
	}
	return now.Sub(i.LastHeartbeat) > time.Duration(i.TTLSeconds)*time.Second
}

// Validate sanity-checks a Service definition.
func (s *Service) Validate() error {
	s.Name = strings.TrimSpace(s.Name)
	if s.Name == "" {
		return errors.New("service name required")
	}
	if strings.ContainsAny(s.Name, " /\\\t\n") {
		return errors.New("service name must not contain whitespace or slashes")
	}
	return nil
}

// Validate sanity-checks an Instance registration.
func (i *Instance) Validate() error {
	if strings.TrimSpace(i.ServiceName) == "" {
		return errors.New("service name required")
	}
	if strings.TrimSpace(i.Address) == "" {
		return errors.New("address required")
	}
	if i.Weight < 0 {
		return errors.New("weight must be >= 0")
	}
	if i.Weight == 0 {
		i.Weight = 1
	}
	if i.TTLSeconds < 0 {
		return errors.New("ttl must be >= 0")
	}
	for idx := range i.Interfaces {
		if err := i.Interfaces[idx].Validate(); err != nil {
			return err
		}
	}
	if i.Status == "" {
		i.Status = StatusUp
	}
	return nil
}

// Validate checks an Interface definition.
func (it *Interface) Validate() error {
	it.Name = strings.TrimSpace(it.Name)
	it.Protocol = strings.ToLower(strings.TrimSpace(it.Protocol))
	if it.Name == "" {
		return errors.New("interface name required")
	}
	if it.Protocol == "" {
		return errors.New("interface protocol required")
	}
	if it.Port <= 0 || it.Port > 65535 {
		return errors.New("interface port out of range")
	}
	return nil
}

// Event types broadcast over WS and gossip.
const (
	EventServiceUpserted  = "service.upserted"
	EventServiceDeleted   = "service.deleted"
	EventInstanceUpserted = "instance.upserted"
	EventInstanceDeleted  = "instance.deleted"
	EventInstanceStatus   = "instance.status"
	EventUserUpserted     = "user.upserted"
	EventUserDeleted      = "user.deleted"
)

// User is a UI/admin account. Service-to-service traffic uses static tokens
// and does not need a User row.
//
// PasswordHash MUST be persisted (bbolt rows are JSON-encoded), but it must
// never reach the wire. Handlers explicitly clear it before writing responses;
// see redactedUser in store/users.go and the explicit zeroing in users_handlers.go.
type User struct {
	ID           string    `json:"id"`
	Username     string    `json:"username"`
	DisplayName  string    `json:"displayName,omitempty"`
	IsAdmin      bool      `json:"isAdmin"`
	PasswordHash string    `json:"passwordHash,omitempty"`
	CreatedAt    time.Time `json:"createdAt"`
	UpdatedAt    time.Time `json:"updatedAt"`
}

// Session ties a cookie token to a user with an expiry.
type Session struct {
	Token     string    `json:"-"`
	UserID    string    `json:"userId"`
	CreatedAt time.Time `json:"createdAt"`
	ExpiresAt time.Time `json:"expiresAt"`
}

// AuditEntry records who did what.
type AuditEntry struct {
	ID         string                 `json:"id"`
	Timestamp  time.Time              `json:"timestamp"`
	ActorID    string                 `json:"actorId,omitempty"` // user ID, "system" for static-token, "anonymous" otherwise
	ActorName  string                 `json:"actorName,omitempty"`
	Action     string                 `json:"action"`           // e.g. service.created
	Target     string                 `json:"target,omitempty"` // service name / user ID / etc.
	TargetType string                 `json:"targetType,omitempty"`
	Details    map[string]interface{} `json:"details,omitempty"`
}

// Audit action constants — keep in sync with anything emitting audit entries.
const (
	AuditServiceCreated   = "service.created"
	AuditServiceUpdated   = "service.updated"
	AuditServiceDeleted   = "service.deleted"
	AuditInstanceUpserted = "instance.upserted"
	AuditInstanceDeleted  = "instance.deleted"
	AuditGrantAdded       = "service.grant.added"
	AuditGrantRemoved     = "service.grant.removed"
	AuditUserCreated      = "user.created"
	AuditUserUpdated      = "user.updated"
	AuditUserDeleted      = "user.deleted"
	AuditUserLogin        = "user.login"
	AuditUserLogout       = "user.logout"
)

// Event is a change notification.
type Event struct {
	Type      string      `json:"type"`
	Service   string      `json:"service,omitempty"`
	Instance  string      `json:"instance,omitempty"`
	Payload   interface{} `json:"payload,omitempty"`
	Timestamp time.Time   `json:"timestamp"`
	OriginID  string      `json:"originId,omitempty"`
}
