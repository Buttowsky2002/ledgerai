package connector

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

func TestModelFromUsageType(t *testing.T) {
	cases := map[string]string{
		"USE1-BedrockTokenCount:anthropic.claude-3-sonnet-input": "anthropic.claude-3-sonnet",
		"USW2-Bedrock:amazon.titan-text-output":                  "amazon.titan-text",
		"USE1-DataTransfer-Out-Bytes":                            "USE1-DataTransfer-Out-Bytes",
	}
	for in, want := range cases {
		if got := modelFromUsageType(in); got != want {
			t.Errorf("modelFromUsageType(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestBedrockFetchSinglePage(t *testing.T) {
	var gotTarget, gotAuth string
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotTarget = r.Header.Get("X-Amz-Target")
		gotAuth = r.Header.Get("Authorization")
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ResultsByTime": []any{map[string]any{
				"TimePeriod": map[string]string{"Start": "2026-06-15", "End": "2026-06-16"},
				"Groups": []any{
					map[string]any{"Keys": []string{"USE1-BedrockTokenCount:anthropic.claude-3-sonnet-input"},
						"Metrics": map[string]any{"UnblendedCost": map[string]string{"Amount": "8.40", "Unit": "USD"}}},
				},
			}},
		})
	}))
	defer srv.Close()

	_ = os.Setenv("AWS_ACCESS_KEY_ID", "AKIDEXAMPLE")
	_ = os.Setenv("AWS_SECRET_ACCESS_KEY", "secret")
	c := NewBedrockConnector()
	c.now = fixedClock()
	cfg := map[string]any{"base_url": srv.URL}

	pg, err := c.Fetch(context.Background(), cfg, Cursor{})
	if err != nil {
		t.Fatal(err)
	}
	if gotTarget != "AWSInsightsIndexService.GetCostAndUsage" {
		t.Fatalf("X-Amz-Target = %q", gotTarget)
	}
	if !strings.HasPrefix(gotAuth, "AWS4-HMAC-SHA256 ") {
		t.Fatalf("request not SigV4-signed: %q", gotAuth)
	}
	// Body should filter to the Bedrock service and group by usage type.
	filt, _ := json.Marshal(gotBody["Filter"])
	if !strings.Contains(string(filt), "Amazon Bedrock") {
		t.Fatalf("filter missing Bedrock service: %s", filt)
	}
	if len(pg.Records) != 1 {
		t.Fatalf("records = %d, want 1", len(pg.Records))
	}
	r0 := pg.Records[0]
	if r0.Provider != "aws_bedrock" || r0.Model != "anthropic.claude-3-sonnet" ||
		r0.Day != "2026-06-15" || r0.CostUSD != 8.40 || r0.Currency != "USD" {
		t.Fatalf("record0 wrong: %+v", r0)
	}
	if !pg.Done {
		t.Fatal("single page should be Done")
	}
}

func TestBedrockFetchPagination(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		resp := map[string]any{"ResultsByTime": []any{map[string]any{
			"TimePeriod": map[string]string{"Start": "2026-06-15", "End": "2026-06-16"},
			"Groups": []any{map[string]any{"Keys": []string{"x"},
				"Metrics": map[string]any{"UnblendedCost": map[string]string{"Amount": "1.0", "Unit": "USD"}}}},
		}}}
		if _, ok := body["NextPageToken"]; !ok {
			resp["NextPageToken"] = "tok2"
		}
		_ = json.NewEncoder(w).Encode(resp)
	}))
	defer srv.Close()

	_ = os.Setenv("AWS_ACCESS_KEY_ID", "AK")
	_ = os.Setenv("AWS_SECRET_ACCESS_KEY", "SK")
	c := NewBedrockConnector()
	c.now = fixedClock()
	cfg := map[string]any{"base_url": srv.URL}

	pg1, err := c.Fetch(context.Background(), cfg, Cursor{})
	if err != nil {
		t.Fatal(err)
	}
	if pg1.Done || pg1.Next.Value["page"] != "tok2" {
		t.Fatalf("first page should carry NextPageToken and not be Done: %+v", pg1.Next)
	}
	pg2, err := c.Fetch(context.Background(), cfg, pg1.Next)
	if err != nil {
		t.Fatal(err)
	}
	if !pg2.Done {
		t.Fatal("second page should be Done")
	}
}

func TestBedrockMissingCreds(t *testing.T) {
	_ = os.Unsetenv("AWS_ACCESS_KEY_ID")
	_ = os.Unsetenv("AWS_SECRET_ACCESS_KEY")
	c := NewBedrockConnector()
	_, err := c.Fetch(context.Background(), map[string]any{}, Cursor{})
	if err == nil {
		t.Fatal("expected error when AWS creds are absent")
	}
}
