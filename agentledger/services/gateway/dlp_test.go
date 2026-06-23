package main

import (
	"encoding/json"
	"strings"
	"testing"
)

// awsExampleKey is the canonical AWS documentation example key (not a real
// secret); it matches the aws_access_key classifier (AKIA + 16 [0-9A-Z]).
const awsExampleKey = "AKIAIOSFODNN7EXAMPLE"

func hasFinding(fs []Finding, class string) bool {
	for _, f := range fs {
		if f.Class == class {
			return true
		}
	}
	return false
}

// assertValidJSON fails if b is not a well-formed JSON object.
func assertValidJSON(t *testing.T, b []byte) {
	t.Helper()
	var v map[string]any
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatalf("output is not valid JSON: %v\n%s", err, b)
	}
}

func TestRedactBodyStringContent(t *testing.T) {
	d := NewDLPEngine(DLPConfig{})
	body := []byte(`{"model":"gpt-4o","messages":[{"role":"user","content":"my key is ` + awsExampleKey + ` ok"}]}`)

	out := redactBody(d, body)
	s := string(out)

	assertValidJSON(t, out)
	if strings.Contains(s, awsExampleKey) {
		t.Fatalf("raw AWS key survived redaction: %s", s)
	}
	if !strings.Contains(s, "[REDACTED:AWS_ACCESS_KEY]") {
		t.Fatalf("expected redaction token in output: %s", s)
	}
}

func TestRedactBodyMultimodalTextPart(t *testing.T) {
	d := NewDLPEngine(DLPConfig{})
	const imageURL = "https://example.com/cat.png"
	body := []byte(`{"model":"gpt-4o","messages":[{"role":"user","content":[` +
		`{"type":"text","text":"leak ` + awsExampleKey + ` here"},` +
		`{"type":"image_url","image_url":{"url":"` + imageURL + `"}}` +
		`]}]}`)

	out := redactBody(d, body)
	s := string(out)

	assertValidJSON(t, out)
	// Text part is redacted...
	if strings.Contains(s, awsExampleKey) {
		t.Fatalf("raw AWS key survived redaction in a text part: %s", s)
	}
	if !strings.Contains(s, "[REDACTED:AWS_ACCESS_KEY]") {
		t.Fatalf("expected redaction token in output: %s", s)
	}
	// ...and the non-text part is preserved unchanged.
	if !strings.Contains(s, imageURL) {
		t.Fatalf("image_url part was not preserved: %s", s)
	}
	if !strings.Contains(s, `"image_url"`) {
		t.Fatalf("image_url part type was not preserved: %s", s)
	}
}

func TestRedactBodyImagePartUnchanged(t *testing.T) {
	d := NewDLPEngine(DLPConfig{})
	// A message whose only part is a non-text part: nothing to redact, structure
	// and the part must be preserved.
	const imageURL = "https://example.com/secret-looking-but-not.png"
	body := []byte(`{"model":"gpt-4o","messages":[{"role":"user","content":[` +
		`{"type":"image_url","image_url":{"url":"` + imageURL + `"}}` +
		`]}]}`)

	out := redactBody(d, body)
	s := string(out)

	assertValidJSON(t, out)
	if !strings.Contains(s, imageURL) {
		t.Fatalf("image_url was altered/dropped: %s", s)
	}
	if strings.Contains(s, "[REDACTED") {
		t.Fatalf("non-text part should not be redacted: %s", s)
	}
}

func TestRedactBodyInvalidJSONReturnsOriginal(t *testing.T) {
	d := NewDLPEngine(DLPConfig{})
	body := []byte(`{not valid json`)

	// Must not panic, and must return the original bytes unchanged.
	out := redactBody(d, body)
	if string(out) != string(body) {
		t.Fatalf("invalid JSON should pass through unchanged: got %s", out)
	}
}

func TestIPv4ClassifierRejectsInvalidOctets(t *testing.T) {
	d := NewDLPEngine(DLPConfig{})
	if hasFinding(d.Classify("connect to 999.999.999.999 now"), "ipv4_address") {
		t.Fatal("invalid IPv4 (octets > 255) must not produce a finding")
	}
}

func TestIPv4ClassifierAcceptsValidAddress(t *testing.T) {
	d := NewDLPEngine(DLPConfig{})
	if !hasFinding(d.Classify("server at 192.168.1.1 responded"), "ipv4_address") {
		t.Fatal("valid IPv4 must produce a finding")
	}
}
