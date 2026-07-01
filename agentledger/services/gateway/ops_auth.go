package main

import (
	"crypto/subtle"
	"log/slog"
	"net"
	"net/http"
	"strings"
)

// opsAuthConfig governs access to the operational endpoints (/v1/usage and
// /metrics), which expose spend/usage internals and must not be world-readable.
//
// The ops token is a secret supplied via the environment (security rule 1) and
// is NEVER logged. Resolution order for every setting prefers the LEDGERAI_*
// name and falls back to the deprecated AGENTLEDGER_* alias (see lookupEnv).
type opsAuthConfig struct {
	token         string // shared bearer for ops endpoints; "" = not configured
	production    bool   // BADGERIQ_ENV=production — locks ops endpoints when no token
	allowUnauth   bool   // dev-only escape hatch: allow unauthenticated ops access
	metricsPublic bool   // expose /metrics without auth (trusted private scrape network)
}

// loadOpsAuthConfig reads ops-endpoint auth settings from the environment.
// Preferred names (deprecated AGENTLEDGER_* aliases are also accepted):
//   - BADGERIQ_OPS_TOKEN        bearer token required on /v1/usage and /metrics
//   - BADGERIQ_ENV              "production" locks ops endpoints when no token is set
//   - BADGERIQ_ALLOW_UNAUTH_OPS "true" allows unauthenticated ops access (dev only)
//   - BADGERIQ_METRICS_PUBLIC   "true" exposes /metrics without auth (private scrape net)
func loadOpsAuthConfig() opsAuthConfig {
	return opsAuthConfig{
		token:         lookupEnv("BADGERIQ_OPS_TOKEN"),
		production:    strings.EqualFold(lookupEnv("BADGERIQ_ENV"), "production"),
		allowUnauth:   lookupEnv("BADGERIQ_ALLOW_UNAUTH_OPS") == "true",
		metricsPublic: lookupEnv("BADGERIQ_METRICS_PUBLIC") == "true",
	}
}

// authorize decides whether a request may access an ops endpoint, returning
// (true, 200) when allowed or (false, status) with the status to send.
//
//   - Token configured  → require a matching Bearer token (constant-time); else 401.
//   - No token, prod     → 404 (hide the endpoint entirely).
//   - No token, dev      → allow if BADGERIQ_ALLOW_UNAUTH_OPS=true, else localhost only; else 401.
func (c opsAuthConfig) authorize(r *http.Request) (bool, int) {
	if c.token != "" {
		if opsBearerMatches(r, c.token) {
			return true, http.StatusOK
		}
		return false, http.StatusUnauthorized
	}
	if c.production {
		return false, http.StatusNotFound
	}
	if c.allowUnauth {
		return true, http.StatusOK
	}
	if isLoopback(r.RemoteAddr) {
		return true, http.StatusOK
	}
	return false, http.StatusUnauthorized
}

// opsBearerMatches constant-time-compares the request's Bearer token against the
// configured ops token. Returns false for a missing/malformed Authorization header.
func opsBearerMatches(r *http.Request, token string) bool {
	const prefix = "Bearer "
	h := r.Header.Get("Authorization")
	if len(h) <= len(prefix) || !strings.EqualFold(h[:len(prefix)], prefix) {
		return false
	}
	got := strings.TrimSpace(h[len(prefix):])
	return subtle.ConstantTimeCompare([]byte(got), []byte(token)) == 1
}

// isLoopback reports whether remoteAddr (host:port) is a loopback address. The
// peer address is taken from the socket (RemoteAddr), never from a spoofable
// header such as X-Forwarded-For.
func isLoopback(remoteAddr string) bool {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		host = remoteAddr
	}
	ip := net.ParseIP(strings.TrimSpace(host))
	return ip != nil && ip.IsLoopback()
}

// guardOps wraps an ops handler with token authorization. When isMetrics is true,
// an operator may expose /metrics unauthenticated on a trusted private scrape
// network by setting BADGERIQ_METRICS_PUBLIC=true.
func (g *Gateway) guardOps(isMetrics bool, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if isMetrics && g.ops.metricsPublic {
			next(w, r)
			return
		}
		if ok, status := g.ops.authorize(r); !ok {
			if status == http.StatusUnauthorized {
				w.Header().Set("WWW-Authenticate", `Bearer realm="ledgerai-ops"`)
			}
			http.Error(w, http.StatusText(status), status)
			return
		}
		next(w, r)
	}
}

// logOpsAuthStartup emits a one-time startup log describing how the ops endpoints
// are protected. It never logs the token value itself.
func logOpsAuthStartup(c opsAuthConfig) {
	switch {
	case c.token != "":
		slog.Info("ops endpoints protected by bearer token", "endpoints", "/v1/usage,/metrics")
	case c.production:
		slog.Error("ops token not configured in production: /v1/usage and /metrics are locked (404). Set BADGERIQ_OPS_TOKEN")
	case c.allowUnauth:
		slog.Warn("ops endpoints are UNAUTHENTICATED (BADGERIQ_ALLOW_UNAUTH_OPS=true) — development only; never use in production")
	default:
		slog.Warn("ops token not configured: /v1/usage and /metrics allowed from localhost only. Set BADGERIQ_OPS_TOKEN for remote access")
	}
	if c.metricsPublic {
		slog.Warn("/metrics is exposed without auth (BADGERIQ_METRICS_PUBLIC=true) — restrict it to a private scrape network")
	}
}
