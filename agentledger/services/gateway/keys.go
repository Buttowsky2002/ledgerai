package main

import "sync"

// ---------- Virtual key store ----------

type KeyStore struct {
	mu   sync.RWMutex
	keys map[string]*VirtualKey
}

func NewKeyStore(keys []VirtualKey) *KeyStore {
	m := make(map[string]*VirtualKey, len(keys))
	for i := range keys {
		m[keys[i].Key] = &keys[i]
	}
	return &KeyStore{keys: m}
}

func (s *KeyStore) Lookup(key string) (*VirtualKey, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	vk, ok := s.keys[key]
	return vk, ok
}
