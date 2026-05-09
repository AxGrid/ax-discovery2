package store

import (
	"path/filepath"
	"testing"

	"github.com/axgrid/discovery2/internal/model"
)

func TestUserCRUDByUsername(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(filepath.Join(dir, "u.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	u := &model.User{
		ID:           "id-1",
		Username:     "admin",
		PasswordHash: "h",
		IsAdmin:      true,
	}
	if err := s.PutUser(u); err != nil {
		t.Fatalf("put: %v", err)
	}
	got, err := s.GetUserByUsername("admin")
	if err != nil {
		t.Fatalf("by name: %v", err)
	}
	if got.ID != "id-1" {
		t.Fatalf("wrong id: %s", got.ID)
	}
}
