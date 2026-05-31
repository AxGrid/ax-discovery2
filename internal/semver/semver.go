// Package semver is a thin wrapper around github.com/Masterminds/semver/v3
// that gives discovery a single, well-defined place for parsing version
// strings and npm-style constraint expressions (>=2.1.0, ^2.1.0, ~2.1.0,
// 1.x, 1.2.0 - 1.3.5). Keeping it in one package means the server, tests, and
// any future caller agree on exactly which constraint dialect we support.
package semver

import (
	"strings"

	mm "github.com/Masterminds/semver/v3"
)

// Valid reports whether v parses as a (lenient) semantic version. Leading "v"
// and short forms like "2" or "2.1" are accepted, matching Masterminds.
func Valid(v string) bool {
	if strings.TrimSpace(v) == "" {
		return false
	}
	_, err := mm.NewVersion(v)
	return err == nil
}

// ValidConstraint reports whether expr parses as a constraint expression.
func ValidConstraint(expr string) bool {
	if strings.TrimSpace(expr) == "" {
		return false
	}
	_, err := mm.NewConstraint(expr)
	return err == nil
}

// Match reports whether version satisfies the constraint expression. A version
// that does not parse never matches (returns false, nil) — callers treat
// unversioned/garbage instances as excluded. A constraint that does not parse
// is a caller error and returns the parse error.
func Match(version, constraint string) (bool, error) {
	c, err := mm.NewConstraint(constraint)
	if err != nil {
		return false, err
	}
	v, err := mm.NewVersion(version)
	if err != nil {
		// Unversioned or non-semver instance: excluded under a constraint.
		return false, nil
	}
	return c.Check(v), nil
}

// Floor returns the lowest version token mentioned in a constraint expression
// (e.g. ">=2.1.0" → "2.1.0", "1.2.0 - 1.3.5" → "1.2.0", "^2.1" → "2.1"). It's
// used to order overlapping version blocks during config resolution — the block
// with the higher floor wins. Returns "" when nothing parses.
func Floor(constraint string) string {
	toks := strings.FieldsFunc(constraint, func(r rune) bool {
		// keep version-ish runes together; split on operators/space/commas.
		return !(r == '.' || r == '+' || r == '-' || (r >= '0' && r <= '9') ||
			(r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z'))
	})
	best := ""
	for _, t := range toks {
		if _, err := mm.NewVersion(t); err != nil {
			continue
		}
		if best == "" || Compare(t, best) < 0 {
			best = t
		}
	}
	return best
}

// Compare returns -1, 0, or +1 if a is less than, equal to, or greater than b.
// Both must be valid versions; invalid versions sort last (treated as lowest).
func Compare(a, b string) int {
	va, ea := mm.NewVersion(a)
	vb, eb := mm.NewVersion(b)
	switch {
	case ea != nil && eb != nil:
		return 0
	case ea != nil:
		return -1
	case eb != nil:
		return 1
	default:
		return va.Compare(vb)
	}
}
