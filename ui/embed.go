package ui

import "embed"

// UI holds the built React assets. The "dist" subdirectory is what Vite outputs.
// We embed the entire ui/dist tree at compile time. If it doesn't exist yet,
// the placeholder index.html below is used instead so the binary still builds.
//
//go:embed all:dist
var UI embed.FS
