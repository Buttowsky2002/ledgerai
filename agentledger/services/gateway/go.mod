module github.com/agentledger/gateway

go 1.22

require (
	github.com/alicebob/miniredis/v2 v2.33.0
	github.com/redis/go-redis/v9 v9.7.3
)

// Run `go mod tidy` (or `make deps`) to populate go.sum with verified checksums.
// If Go is not installed locally: docker run --rm -v "${PWD}:/w" -w /w golang:1.22-alpine go mod tidy
