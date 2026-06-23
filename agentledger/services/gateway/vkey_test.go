package main

import (
	"encoding/json"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

// These tests prove the virtual-key refactor never stores, emits, or exposes a
// plaintext bearer token. testGateway/doChat live in gateway_test.go.

// 1 + 3: a file-config plaintext key authenticates, and the emitted event's
// virtual_key_id is the derived KeyID — never the plaintext token.
func TestPlaintextKeyAuthenticates_EventUsesKeyID(t *testing.T) {
	up := mockUpstream(t)
	defer up.Close()
	g := testGateway(t, up.URL)

	w, ev := doChat(t, g, "alk_test", "hello there")
	if w.Code != 200 {
		t.Fatalf("plaintext key should authenticate, got %d: %s", w.Code, w.Body.String())
	}
	if ev.VirtualKey == "alk_test" {
		t.Fatal("event virtual_key_id leaked the plaintext key")
	}
	wantKeyID := "vk_" + sha256hex("alk_test")[:16]
	if ev.VirtualKey != wantKeyID {
		t.Fatalf("event virtual_key_id = %q, want derived KeyID %q", ev.VirtualKey, wantKeyID)
	}
	if !strings.HasPrefix(ev.VirtualKey, "vk_") {
		t.Fatalf("virtual_key_id should be a vk_ id, got %q", ev.VirtualKey)
	}
}

// 2: after construction the in-memory VirtualKeys retain no plaintext, and are
// indexed by their hash.
func TestStoredVirtualKeyHasNoPlaintext(t *testing.T) {
	up := mockUpstream(t)
	defer up.Close()
	g := testGateway(t, up.URL)

	ks := g.current.Load().keys
	ks.mu.RLock()
	defer ks.mu.RUnlock()
	if len(ks.keys) == 0 {
		t.Fatal("no keys loaded")
	}
	for hash, vk := range ks.keys {
		if vk.KeyPlaintext != "" {
			t.Fatalf("stored VirtualKey retained plaintext: %q", vk.KeyPlaintext)
		}
		if vk.KeyHash != hash {
			t.Fatalf("map key %q != VirtualKey.KeyHash %q", hash, vk.KeyHash)
		}
		if !strings.HasPrefix(vk.KeyID, "vk_") {
			t.Fatalf("KeyID not derived: %q", vk.KeyID)
		}
		if strings.HasPrefix(vk.KeyHash, "alk_") || strings.HasPrefix(vk.KeyID, "alk_") {
			t.Fatalf("plaintext-looking value stored: hash=%q id=%q", vk.KeyHash, vk.KeyID)
		}
	}
}

// 4: the /v1/usage snapshot exposes only KeyIDs — never a plaintext key.
func TestSnapshotExposesKeyIDOnly(t *testing.T) {
	up := mockUpstream(t)
	defer up.Close()
	g := testGateway(t, up.URL)

	if w, _ := doChat(t, g, "alk_test", "hello"); w.Code != 200 {
		t.Fatalf("setup call failed: %d", w.Code)
	}

	snap := g.budgets.Snapshot()
	blob, _ := json.Marshal(snap)
	body := string(blob)
	if strings.Contains(body, "alk_test") {
		t.Fatalf("snapshot leaked plaintext key: %s", body)
	}
	wantKeyID := "vk_" + sha256hex("alk_test")[:16]
	if !strings.Contains(body, wantKeyID) {
		t.Fatalf("snapshot should contain KeyID %q: %s", wantKeyID, body)
	}
}

// 5: a hashed (Postgres-style) key configuration authenticates against the
// matching plaintext bearer.
func TestHashedKeyConfigAuthenticates(t *testing.T) {
	up := mockUpstream(t)
	defer up.Close()

	const bearer = "alk_from_postgres"
	hash := sha256hex(bearer)
	pb := &PriceBook{entries: []PriceEntry{
		{Provider: "openai", Model: "gpt-4o", TokenType: "input", USDPerMillion: 2.5, EffectiveStart: time.Unix(0, 0)},
		{Provider: "openai", Model: "gpt-4o", TokenType: "output", USDPerMillion: 10, EffectiveStart: time.Unix(0, 0)},
	}}
	cfg := &Config{
		Providers: []ProviderCfg{{Name: "openai", BaseURL: up.URL, APIKeyEnv: "TEST_UPSTREAM_KEY", ModelPrefixes: []string{"gpt-"}}},
		// KeyHash set (no plaintext) — the Postgres path.
		VirtualKeys: []VirtualKey{{KeyHash: hash, TenantID: "t1", Environment: "test", MonthlyBudget: 100}},
	}
	_ = os.Setenv("TEST_UPSTREAM_KEY", "sk-upstream")
	g := newGateway(cfg, pb, NewBudgetStore(cfg.VirtualKeys),
		NewEventSink(EventSinkCfg{Type: "file", Path: os.DevNull, FlushMs: 10, BufferSize: 64}))

	w, ev := doChat(t, g, bearer, "hello")
	if w.Code != 200 {
		t.Fatalf("hashed-config key should authenticate, got %d: %s", w.Code, w.Body.String())
	}
	if ev.VirtualKey != "vk_"+hash[:16] {
		t.Fatalf("virtual_key_id = %q, want %q", ev.VirtualKey, "vk_"+hash[:16])
	}

	// An unknown bearer is still rejected.
	body := `{"model":"gpt-4o","messages":[]}`
	r := httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(body))
	r.Header.Set("Authorization", "Bearer alk_wrong")
	rec := httptest.NewRecorder()
	g.handleChatCompletions(rec, r)
	if rec.Code != 401 {
		t.Fatalf("unknown key should be 401, got %d", rec.Code)
	}
}
