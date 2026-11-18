package browsergo

import _ "embed"

// AppVersion is the current Browser-Go release version (overridable via -ldflags).
var AppVersion = "2.0.0"

//go:embed openapi.yaml
var OpenAPIYAML []byte
