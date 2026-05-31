package model

import "time"

// ClientToken is a UI-minted service-to-service bearer token. Unlike the static
// env tokens (DISCOVERY_*_TOKENS) these are stored, listed, and revoked at
// runtime, and replicated across the cluster. The secret is stored in the clear
// (an operator decision) so it can be re-displayed/copied in the UI — pair with
// DISCOVERY_GOSSIP_SECRET to keep it off the wire.
type ClientToken struct {
	ID        string    `json:"id"`
	Token     string    `json:"token"`           // the bearer secret
	Name      string    `json:"name"`            // operator label
	Role      string    `json:"role"`            // read | write | admin
	CreatedAt time.Time `json:"createdAt"`
	CreatedBy string    `json:"createdBy,omitempty"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// Token event types (replicated like the rest of the store).
const (
	EventTokenUpserted = "token.upserted"
	EventTokenDeleted  = "token.deleted"
)

// Token audit actions.
const (
	AuditTokenCreated = "token.created"
	AuditTokenRevoked = "token.revoked"
)
