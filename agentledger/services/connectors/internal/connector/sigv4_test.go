package connector

import (
	"net/http"
	"testing"
	"time"
)

// Validates the signer against AWS's published Signature Version 4 example
// (GET https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08).
// If this matches, the canonical-request + signing-key + signature math is
// correct, so the Cost Explorer POST path (same algorithm with a body hash) is
// trustworthy.
func TestSigV4MatchesAWSVector(t *testing.T) {
	req, _ := http.NewRequest(http.MethodGet,
		"https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08", nil)
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded; charset=utf-8")

	creds := awsCreds{
		AccessKey: "AKIDEXAMPLE",
		SecretKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
	}
	ts := time.Date(2015, 8, 30, 12, 36, 0, 0, time.UTC)
	signV4(req, nil, creds, "us-east-1", "iam", ts)

	want := "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, " +
		"SignedHeaders=content-type;host;x-amz-date, " +
		"Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7"
	if got := req.Header.Get("Authorization"); got != want {
		t.Fatalf("Authorization mismatch:\n got: %s\nwant: %s", got, want)
	}
	if req.Header.Get("X-Amz-Date") != "20150830T123600Z" {
		t.Fatalf("X-Amz-Date = %q", req.Header.Get("X-Amz-Date"))
	}
}

func TestSigV4AddsSessionToken(t *testing.T) {
	req, _ := http.NewRequest(http.MethodPost, "https://ce.us-east-1.amazonaws.com/", nil)
	signV4(req, []byte(`{"x":1}`), awsCreds{AccessKey: "AK", SecretKey: "SK", SessionToken: "TOKEN"}, "us-east-1", "ce", time.Unix(0, 0))
	if req.Header.Get("X-Amz-Security-Token") != "TOKEN" {
		t.Fatal("session token header not set")
	}
	if req.Header.Get("Authorization") == "" {
		t.Fatal("authorization not set")
	}
}
