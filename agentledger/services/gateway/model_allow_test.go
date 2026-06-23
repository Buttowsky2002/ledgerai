package main

import "testing"

func TestModelAllowed(t *testing.T) {
	cases := []struct {
		name    string
		allowed []string
		model   string
		want    bool
	}{
		{"exact match", []string{"gpt-4o"}, "gpt-4o", true},
		{"exact does not prefix-match", []string{"gpt-4o"}, "gpt-4o-mini", false},
		{"wildcard prefix-matches", []string{"gpt-4o*"}, "gpt-4o-mini", true},
		{"wildcard matches the base too", []string{"gpt-4o*"}, "gpt-4o", true},
		{"wildcard does not match a different family", []string{"gpt-4o*"}, "claude-3-5", false},
		{"empty allowlist allows any", nil, "anything-at-all", true},
		{"whitespace patterns ignored, valid one still matches", []string{"", "   ", "gpt-4o"}, "gpt-4o", true},
		{"whitespace patterns ignored, non-listed denied", []string{"", "   ", "gpt-4o"}, "gpt-5", false},
		{"surrounding whitespace trimmed (exact)", []string{"  gpt-4o  "}, "gpt-4o", true},
		{"surrounding whitespace trimmed (wildcard)", []string{"  gpt-4o*  "}, "gpt-4o-mini", true},
		{"only-whitespace allowlist denies (not empty)", []string{"  "}, "gpt-4o", false},
		{"multiple patterns, one matches", []string{"claude-3*", "gpt-4o"}, "gpt-4o", true},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			vk := &VirtualKey{AllowedModels: tc.allowed}
			if got := modelAllowed(vk, tc.model); got != tc.want {
				t.Fatalf("modelAllowed(%q, %q) = %v, want %v", tc.allowed, tc.model, got, tc.want)
			}
		})
	}
}
