package main

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"sync"
)

// KeyStore is an in-memory lookup of virtual keys indexed by the SHA-256 hash
// of their bearer token; plaintext tokens are never retained.
type KeyStore struct {
	mu   sync.RWMutex
	keys map[string]*VirtualKey // map key is sha256hex(bearer_token) == VirtualKey.KeyHash
}

// normalizeKey prepares a VirtualKey for in-memory storage: it derives KeyHash
// from the plaintext token when needed, CLEARS the plaintext so it is never
// retained, and derives a public KeyID when one was not supplied. It is
// idempotent — safe to call more than once on the same key.
func normalizeKey(vk *VirtualKey) {
	if vk.KeyHash == "" && vk.KeyPlaintext != "" {
		vk.KeyHash = sha256hex(vk.KeyPlaintext)
	}
	vk.KeyPlaintext = "" // never retain the plaintext bearer token in memory
	if vk.KeyID == "" && vk.KeyHash != "" {
		vk.KeyID = "vk_" + vk.KeyHash[:16]
	}
}

// NewKeyStore builds a KeyStore from VirtualKeys supplied by file config, whose
// KeyPlaintext field holds the bearer token. Each key is normalized (hashed,
// plaintext cleared, KeyID derived) and indexed by its SHA-256 hash.
func NewKeyStore(keys []VirtualKey) *KeyStore { return buildKeyStore(keys) }

// NewKeyStoreFromHashed builds a KeyStore from VirtualKeys whose KeyHash already
// holds the SHA-256 hex of the bearer token (Postgres virtual_keys.key_hash).
// normalizeKey handles both forms, so this shares the same builder.
func NewKeyStoreFromHashed(keys []VirtualKey) *KeyStore { return buildKeyStore(keys) }

func buildKeyStore(keys []VirtualKey) *KeyStore {
	m := make(map[string]*VirtualKey, len(keys))
	for i := range keys {
		normalizeKey(&keys[i])
		if keys[i].KeyHash == "" {
			continue // no usable credential (neither plaintext nor hash) — skip
		}
		m[keys[i].KeyHash] = &keys[i]
	}
	return &KeyStore{keys: m}
}

// Lookup finds the VirtualKey for bearer. The bearer value is SHA-256 hashed
// before the map lookup so plaintext tokens are never retained.
func (s *KeyStore) Lookup(bearer string) (*VirtualKey, bool) {
	h := sha256hex(bearer)
	s.mu.RLock()
	defer s.mu.RUnlock()
	vk, ok := s.keys[h]
	return vk, ok
}

func sha256hex(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:])
}

// redactKey returns a stable, non-secret identifier safe to expose in the
// /v1/usage snapshot — the plaintext bearer token must never leave the perimeter.
// A value that is already a KeyID ("vk_...") is returned unchanged; a SHA-256 hex
// is truncated in place (so ops can correlate it); anything else (e.g. a stray
// plaintext key) is hashed. Never returns the plaintext.
func redactKey(k string) string {
	if k == "" {
		return ""
	}
	if strings.HasPrefix(k, "vk_") {
		return k // already a public key id
	}
	if isSHA256Hex(k) {
		return "vk_" + k[:12]
	}
	return "vk_" + sha256hex(k)[:12]
}

// isSHA256Hex reports whether s is a 64-char lowercase hex string (a SHA-256 hex
// digest, the form our key hashes take).
func isSHA256Hex(s string) bool {
	if len(s) != 64 {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')) {
			return false
		}
	}
	return true
}
