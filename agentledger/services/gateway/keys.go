package main

import (
	"crypto/sha256"
	"encoding/hex"
	"sync"
)

type KeyStore struct {
	mu   sync.RWMutex
	keys map[string]*VirtualKey // map key is sha256hex(bearer_token)
}

// NewKeyStore builds a KeyStore from VirtualKeys whose Key field holds the
// plaintext bearer token (file-based config). Keys are stored by SHA-256 hash
// so the plaintext is never retained in memory.
func NewKeyStore(keys []VirtualKey) *KeyStore {
	m := make(map[string]*VirtualKey, len(keys))
	for i := range keys {
		m[sha256hex(keys[i].Key)] = &keys[i]
	}
	return &KeyStore{keys: m}
}

// NewKeyStoreFromHashed builds a KeyStore where each VirtualKey.Key already
// holds the SHA-256 hex of the bearer token (as stored in Postgres key_hash).
// No additional hashing is applied during construction.
func NewKeyStoreFromHashed(keys []VirtualKey) *KeyStore {
	m := make(map[string]*VirtualKey, len(keys))
	for i := range keys {
		m[keys[i].Key] = &keys[i]
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
