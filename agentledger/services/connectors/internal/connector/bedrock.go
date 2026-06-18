package connector

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

// BedrockConnector imports AWS Bedrock spend from the AWS Cost Explorer API
// (GetCostAndUsage), filtered to the Bedrock service, grouped by usage type and
// day. It signs requests with SigV4 using credentials from env vars named in
// the connector config.
//
// Cursor shape: {"start": "YYYY-MM-DD", "page": "<NextPageToken>"}. start is the
// incremental day watermark; page carries Cost Explorer's NextPageToken. On
// completion the watermark advances to today so the still-accruing current day
// re-imports next run (provider_costs ReplacingMergeTree keeps the latest).
type BedrockConnector struct {
	client *http.Client
	now    func() time.Time
}

func NewBedrockConnector() *BedrockConnector {
	return &BedrockConnector{
		client: &http.Client{Timeout: 30 * time.Second},
		now:    time.Now,
	}
}

func (c *BedrockConnector) Kind() string { return "bedrock" }

type ceResponse struct {
	NextPageToken string `json:"NextPageToken"`
	ResultsByTime []struct {
		TimePeriod struct {
			Start string `json:"Start"`
			End   string `json:"End"`
		} `json:"TimePeriod"`
		Groups []struct {
			Keys    []string `json:"Keys"`
			Metrics struct {
				UnblendedCost struct {
					Amount string `json:"Amount"`
					Unit   string `json:"Unit"`
				} `json:"UnblendedCost"`
			} `json:"Metrics"`
		} `json:"Groups"`
	} `json:"ResultsByTime"`
}

func (c *BedrockConnector) Fetch(ctx context.Context, cfg map[string]any, cur Cursor) (Page, error) {
	baseURL := cfgString(cfg, "base_url", "https://ce.us-east-1.amazonaws.com")
	region := cfgString(cfg, "region", "us-east-1")
	creds := awsCreds{
		AccessKey:    os.Getenv(cfgString(cfg, "access_key_env", "AWS_ACCESS_KEY_ID")),
		SecretKey:    os.Getenv(cfgString(cfg, "secret_key_env", "AWS_SECRET_ACCESS_KEY")),
		SessionToken: os.Getenv(cfgString(cfg, "session_token_env", "AWS_SESSION_TOKEN")),
	}
	if creds.AccessKey == "" || creds.SecretKey == "" {
		return Page{}, fmt.Errorf("bedrock: AWS access key/secret env vars are empty")
	}
	service := cfgString(cfg, "service_name", "Amazon Bedrock")
	lookbackDays := cfgInt(cfg, "lookback_days", 30)

	now := c.now().UTC()
	start := now.AddDate(0, 0, -lookbackDays).Format("2006-01-02")
	if v, ok := cur.Value["start"].(string); ok && v != "" {
		start = v
	}
	// Cost Explorer's End is exclusive; query through tomorrow to include today.
	end := now.AddDate(0, 0, 1).Format("2006-01-02")
	page, _ := cur.Value["page"].(string)

	reqBody := map[string]any{
		"TimePeriod":  map[string]string{"Start": start, "End": end},
		"Granularity": "DAILY",
		"Metrics":     []string{"UnblendedCost"},
		"Filter": map[string]any{
			"Dimensions": map[string]any{"Key": "SERVICE", "Values": []string{service}},
		},
		"GroupBy": []map[string]string{{"Type": "DIMENSION", "Key": "USAGE_TYPE"}},
	}
	if page != "" {
		reqBody["NextPageToken"] = page
	}
	payload, err := json.Marshal(reqBody)
	if err != nil {
		return Page{}, err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(baseURL, "/")+"/", bytes.NewReader(payload))
	if err != nil {
		return Page{}, err
	}
	req.Header.Set("Content-Type", "application/x-amz-json-1.1")
	req.Header.Set("X-Amz-Target", "AWSInsightsIndexService.GetCostAndUsage")
	signV4(req, payload, creds, region, "ce", c.now())

	resp, err := c.client.Do(req)
	if err != nil {
		return Page{}, fmt.Errorf("cost explorer request: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return Page{}, fmt.Errorf("cost explorer status %d: %s", resp.StatusCode, strings.TrimSpace(string(msg)))
	}

	var body ceResponse
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return Page{}, fmt.Errorf("cost explorer decode: %w", err)
	}

	var records []Record
	maxStart := start
	for _, period := range body.ResultsByTime {
		day := period.TimePeriod.Start
		if day > maxStart {
			maxStart = day
		}
		for _, g := range period.Groups {
			usageType := ""
			if len(g.Keys) > 0 {
				usageType = g.Keys[0]
			}
			amount, _ := strconv.ParseFloat(g.Metrics.UnblendedCost.Amount, 64)
			currency := g.Metrics.UnblendedCost.Unit
			if currency == "" {
				currency = "USD"
			}
			records = append(records, Record{
				Day:      day,
				Provider: "aws_bedrock",
				Model:    modelFromUsageType(usageType),
				LineItem: usageType,
				CostUSD:  amount,
				Currency: strings.ToUpper(currency),
			})
		}
	}

	if body.NextPageToken != "" {
		return Page{
			Records: records,
			Next:    Cursor{Value: map[string]any{"start": start, "page": body.NextPageToken}},
			Done:    false,
		}, nil
	}
	return Page{
		Records: records,
		Next:    Cursor{Value: map[string]any{"start": maxStart}},
		Done:    true,
	}, nil
}

// modelFromUsageType extracts a model-ish label from a Bedrock usage type such
// as "USE1-BedrockTokenCount:anthropic.claude-3-sonnet-input" → the model id.
// Falls back to the raw usage type when no model is embedded.
func modelFromUsageType(usageType string) string {
	if i := strings.LastIndexByte(usageType, ':'); i >= 0 && i+1 < len(usageType) {
		model := usageType[i+1:]
		for _, suffix := range []string{"-input", "-output", "-InputTokens", "-OutputTokens"} {
			model = strings.TrimSuffix(model, suffix)
		}
		return model
	}
	return usageType
}
