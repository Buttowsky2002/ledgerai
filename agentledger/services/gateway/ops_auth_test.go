package main

import (
	"bytes"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// okHandler is a sentinel ops handler that records it was reached.
func okHandler(reached *bool) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		*reached = true
		w.WriteHeader(http.StatusOK)
	}
}

func opsRequest(remoteAddr, bearer string) *http.Request {
	req := httptest.NewRequest(http.MethodGet, "/v1/usage", nil)
	req.RemoteAddr = remoteAddr
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	return req
}

// With an ops token configured: missing/wrong → 401, correct → 200.
func TestGuardOps_TokenConfigured(t *testing.T) {
	g := &Gateway{ops: opsAuthConfig{token: "s3cret-ops-token"}}

	cases := []struct {
		name   string
		bearer string
		want   int
	}{
		{"missing token", "", http.StatusUnauthorized},
		{"wrong token", "nope", http.StatusUnauthorized},
		{"correct token", "s3cret-ops-token", http.StatusOK},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			reached := false
			h := g.guardOps(false, okHandler(&reached))
			rec := httptest.NewRecorder()
			// Remote is non-loopback to prove the token (not localhost) is what grants access.
			h(rec, opsRequest("203.0.113.7:5555", tc.bearer))
			if rec.Code != tc.want {
				t.Fatalf("status: want %d got %d", tc.want, rec.Code)
			}
			if reached != (tc.want == http.StatusOK) {
				t.Fatalf("handler reached=%v, want %v", reached, tc.want == http.StatusOK)
			}
			if tc.want == http.StatusUnauthorized && rec.Header().Get("WWW-Authenticate") == "" {
				t.Fatalf("401 should set WWW-Authenticate")
			}
		})
	}
}

// With no ops token: production hides (404); dev allows localhost only unless the
// explicit unauth flag is set.
func TestGuardOps_NoToken(t *testing.T) {
	cases := []struct {
		name   string
		cfg    opsAuthConfig
		remote string
		want   int
	}{
		{"prod, no token, localhost → 404", opsAuthConfig{production: true}, "127.0.0.1:1", http.StatusNotFound},
		{"prod, no token, remote → 404", opsAuthConfig{production: true}, "203.0.113.7:1", http.StatusNotFound},
		{"dev, no token, localhost → 200", opsAuthConfig{}, "127.0.0.1:1", http.StatusOK},
		{"dev, no token, ipv6 loopback → 200", opsAuthConfig{}, "[::1]:1", http.StatusOK},
		{"dev, no token, remote → 401", opsAuthConfig{}, "203.0.113.7:1", http.StatusUnauthorized},
		{"dev, allow-unauth, remote → 200", opsAuthConfig{allowUnauth: true}, "203.0.113.7:1", http.StatusOK},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			g := &Gateway{ops: tc.cfg}
			reached := false
			h := g.guardOps(false, okHandler(&reached))
			rec := httptest.NewRecorder()
			h(rec, opsRequest(tc.remote, ""))
			if rec.Code != tc.want {
				t.Fatalf("status: want %d got %d", tc.want, rec.Code)
			}
		})
	}
}

// /metrics is protected by default but can be opened for a private scrape network.
func TestGuardOps_Metrics(t *testing.T) {
	t.Run("protected by default (needs token)", func(t *testing.T) {
		g := &Gateway{ops: opsAuthConfig{token: "t"}}
		reached := false
		h := g.guardOps(true, okHandler(&reached))
		rec := httptest.NewRecorder()
		h(rec, opsRequest("203.0.113.7:1", "")) // no token
		if rec.Code != http.StatusUnauthorized || reached {
			t.Fatalf("want 401 unreached, got %d reached=%v", rec.Code, reached)
		}
	})
	t.Run("public scrape bypasses auth", func(t *testing.T) {
		g := &Gateway{ops: opsAuthConfig{metricsPublic: true}} // no token
		reached := false
		h := g.guardOps(true, okHandler(&reached))
		rec := httptest.NewRecorder()
		h(rec, opsRequest("203.0.113.7:1", ""))
		if rec.Code != http.StatusOK || !reached {
			t.Fatalf("want 200 reached, got %d reached=%v", rec.Code, reached)
		}
	})
	t.Run("metricsPublic does not open /v1/usage", func(t *testing.T) {
		g := &Gateway{ops: opsAuthConfig{metricsPublic: true}}
		reached := false
		h := g.guardOps(false, okHandler(&reached)) // isMetrics=false
		rec := httptest.NewRecorder()
		h(rec, opsRequest("203.0.113.7:1", ""))
		if rec.Code != http.StatusUnauthorized || reached {
			t.Fatalf("usage must stay protected: got %d reached=%v", rec.Code, reached)
		}
	})
}

// The usage snapshot must never expose the plaintext virtual key — only the
// non-secret KeyID.
func TestUsageSnapshotRedactsKeys(t *testing.T) {
	const plaintext = "alk_dev_engineering"
	vk := VirtualKey{KeyPlaintext: plaintext}
	normalizeKey(&vk) // hash + clear plaintext, derive KeyID
	bs := NewBudgetStore([]VirtualKey{vk})
	bs.Commit(reserveOK(t, bs, &vk, 0), 1.23) // record some spend under the KeyID

	g := &Gateway{budgets: bs, ops: opsAuthConfig{token: "ops"}}
	h := g.guardOps(false, g.handleUsage)
	rec := httptest.NewRecorder()
	h(rec, opsRequest("203.0.113.7:1", "ops"))

	if rec.Code != http.StatusOK {
		t.Fatalf("want 200 got %d", rec.Code)
	}
	body := rec.Body.String()
	if strings.Contains(body, plaintext) {
		t.Fatalf("plaintext virtual key leaked in usage response: %s", body)
	}
	want := vk.KeyID
	if !strings.HasPrefix(want, "vk_") {
		t.Fatalf("KeyID should be a vk_ id, got %q", want)
	}
	if !strings.Contains(body, want) {
		t.Fatalf("expected KeyID %q in response: %s", want, body)
	}
}

func TestRedactKey(t *testing.T) {
	// Plaintext is hashed (not echoed).
	if got := redactKey("alk_secret"); strings.Contains(got, "alk_secret") || !strings.HasPrefix(got, "vk_") {
		t.Fatalf("plaintext not redacted: %q", got)
	}
	// An already-hashed key (64 hex) is truncated in place for correlation.
	full := sha256hex("alk_secret")
	if got := redactKey(full); got != "vk_"+full[:12] {
		t.Fatalf("hashed key should truncate: got %q want vk_%s", got, full[:12])
	}
	if redactKey("") != "" {
		t.Fatalf("empty stays empty")
	}
}

// Acceptance: the ops token must never appear in logs.
func TestOpsTokenNeverLogged(t *testing.T) {
	const secret = "SUPER-SECRET-OPS-TOKEN"
	var buf bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&buf, nil)))
	defer slog.SetDefault(prev)

	logOpsAuthStartup(opsAuthConfig{token: secret})
	logOpsAuthStartup(opsAuthConfig{production: true})
	logOpsAuthStartup(opsAuthConfig{allowUnauth: true})
	logOpsAuthStartup(opsAuthConfig{metricsPublic: true})

	if strings.Contains(buf.String(), secret) {
		t.Fatalf("ops token leaked into logs: %s", buf.String())
	}
}

func TestOpsBearerConstantTimeMatch(t *testing.T) {
	r := opsRequest("127.0.0.1:1", "the-token")
	if !opsBearerMatches(r, "the-token") {
		t.Fatal("exact token should match")
	}
	if opsBearerMatches(r, "the-token-x") {
		t.Fatal("different-length token must not match")
	}
	if opsBearerMatches(opsRequest("127.0.0.1:1", ""), "the-token") {
		t.Fatal("absent header must not match")
	}
}
