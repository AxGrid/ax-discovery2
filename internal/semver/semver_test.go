package semver

import "testing"

func TestMatch(t *testing.T) {
	cases := []struct {
		version    string
		constraint string
		want       bool
	}{
		{"2.1.0", ">=2.1.0", true},
		{"2.0.9", ">=2.1.0", false},
		{"2.5.0", "^2.1.0", true},
		{"3.0.0", "^2.1.0", false},
		{"2.1.9", "~2.1.0", true},
		{"2.2.0", "~2.1.0", false},
		{"1.4.0", "1.x", true},
		{"2.0.0", "1.x", false},
		{"1.2.5", "1.2.0 - 1.3.5", true},
		{"1.4.0", "1.2.0 - 1.3.5", false},
		{"v2.1.0", ">=2.1.0", true}, // leading v accepted
		{"2.1", ">=2.1.0", true},    // short form accepted
		// Unversioned / garbage never matches a constraint.
		{"", ">=2.1.0", false},
		{"not-a-version", ">=2.1.0", false},
	}
	for _, c := range cases {
		got, err := Match(c.version, c.constraint)
		if err != nil {
			t.Fatalf("Match(%q,%q) unexpected err: %v", c.version, c.constraint, err)
		}
		if got != c.want {
			t.Errorf("Match(%q,%q) = %v, want %v", c.version, c.constraint, got, c.want)
		}
	}
}

func TestMatchBadConstraint(t *testing.T) {
	if _, err := Match("2.1.0", "this is not a constraint!!"); err == nil {
		t.Fatal("expected error for bad constraint")
	}
}

func TestValidConstraint(t *testing.T) {
	if !ValidConstraint(">=2.1.0") {
		t.Error(">=2.1.0 should be valid")
	}
	if ValidConstraint("@@@") {
		t.Error("@@@ should be invalid")
	}
}
