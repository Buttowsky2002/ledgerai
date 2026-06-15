package main

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"strings"
	"time"
)

type Gateway struct {
	cfg       *Config
	keys      *KeyStore
	budgets   BudgetStore
	dlp       *DLPEngine
	prices    *PriceBook
	sink      *EventSink
	transport *http.Transport
}

func newUpstreamTransport() *http.Transport {
	return &http.Transport{
		MaxIdleConns:        512,
		MaxIdleConnsPerHost: 128,
		IdleConnTimeout:     90 * time.Second,
		DialContext: (&net.Dialer{
			Timeout:   5 * time.Second,
			KeepAlive: 30 * time.Second,
		}).DialContext,
	}
}

// chatRequest captures the fields the gateway needs; everything else is
// passed through untouched.
type chatRequest struct {
	Model    string `json:"model"`
	Stream   bool   `json:"stream"`
	Messages []struct {
		Role    string          `json:"role"`
		Content json.RawMessage `json:"content"`
	} `json:"messages"`
}

func (g *Gateway) handleChatCompletions(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	callID := requestIDFrom(r.Context())

	// 1. Authenticate virtual key
	vk, ok := g.authenticate(r)
	if !ok {
		writeErr(w, http.StatusUnauthorized, "invalid_api_key", "unknown or missing AgentLedger virtual key")
		return
	}

	// 2. Read + parse body (bounded)
	body, err := io.ReadAll(io.LimitReader(r.Body, 32<<20))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid_request", "could not read body")
		return
	}
	var req chatRequest
	if err := json.Unmarshal(body, &req); err != nil || req.Model == "" {
		writeErr(w, http.StatusBadRequest, "invalid_request", "body must be OpenAI-compatible JSON with a model")
		return
	}

	ev := LLMCallEvent{
		CallID: callID, Timestamp: start.UTC(),
		TenantID: vk.TenantID, TeamID: vk.TeamID, UserID: vk.UserID,
		AppID: vk.AppID, Environment: vk.Environment, VirtualKey: vk.Key,
		AgentID:      r.Header.Get("X-AgentLedger-Agent-Id"),
		RunID:        r.Header.Get("X-AgentLedger-Run-Id"),
		StepID:       r.Header.Get("X-AgentLedger-Step-Id"),
		RequestModel: req.Model, OperationName: "chat", Streamed: req.Stream,
	}

	// 3. Model allowlist
	if !modelAllowed(vk, req.Model) {
		ev.Status, ev.StatusCode = "blocked_policy", http.StatusForbidden
		g.finish(w, &ev, start, http.StatusForbidden, "model_not_allowed",
			fmt.Sprintf("model %q is not allowed for this key", req.Model))
		return
	}

	// 4. Budget + rate limit precheck
	if ok, reason := g.budgets.CheckAndCount(vk); !ok {
		status := http.StatusTooManyRequests
		ev.Status = "blocked_rate"
		if reason == "monthly_budget_exceeded" {
			status = http.StatusPaymentRequired
			ev.Status = "blocked_budget"
		}
		ev.StatusCode = status
		g.finish(w, &ev, start, status, reason, "request rejected by AgentLedger policy: "+reason)
		return
	}

	// 5. DLP precheck on message content
	promptText := extractText(req)
	ev.PromptHash = hashContent(promptText)
	findings := g.dlp.Classify(promptText)
	action := g.dlp.Decide(vk.DLPPolicyID, findings)
	ev.DLPAction, ev.DLPFindings = action, findings
	ev.RiskSeverity = maxSeverity(findings)

	switch action {
	case "block":
		ev.Status, ev.StatusCode = "blocked_dlp", http.StatusForbidden
		g.finish(w, &ev, start, http.StatusForbidden, "dlp_blocked",
			"request blocked: sensitive data detected ("+findingClasses(findings)+")")
		return
	case "redact":
		body = redactBody(g.dlp, body)
	}

	// 6. Resolve upstream provider
	prov, ok := g.cfg.resolveProvider(req.Model)
	if !ok {
		ev.Status, ev.StatusCode = "blocked_policy", http.StatusBadGateway
		g.finish(w, &ev, start, http.StatusBadGateway, "no_provider", "no upstream configured for model "+req.Model)
		return
	}
	ev.Provider = prov.Name

	// 7. Proxy
	usage, status, respModel, err := g.proxyUpstream(w, r, prov, body, req.Stream)
	ev.StatusCode = status
	ev.ResponseModel = respModel
	if err != nil {
		ev.Status = "upstream_error"
	} else {
		ev.Status = "ok"
	}
	ev.InputTokens, ev.OutputTokens = usage.InputTokens, usage.OutputTokens
	ev.CacheReadTokens, ev.CacheWriteTokens = usage.CacheReadTokens, usage.CacheWriteTokens

	// 8. Cost accounting (response model preferred for pricing accuracy)
	priceModel := respModel
	if priceModel == "" {
		priceModel = req.Model
	}
	ev.CostUSD = g.prices.Cost(prov.Name, priceModel, usage, start)
	g.budgets.AddSpend(vk.Key, ev.CostUSD)

	// 9. Emit canonical event (async, non-blocking)
	ev.LatencyMs = time.Since(start).Milliseconds()
	g.sink.Emit(ev)
}

// proxyUpstream forwards the request and captures usage from either the
// JSON response or the final SSE chunks (stream_options.include_usage).
func (g *Gateway) proxyUpstream(w http.ResponseWriter, r *http.Request, prov *ProviderCfg, body []byte, stream bool) (Usage, int, string, error) {
	var u Usage
	if stream {
		body = ensureStreamUsage(body)
	}
	upReq, err := http.NewRequestWithContext(r.Context(), "POST",
		strings.TrimRight(prov.BaseURL, "/")+"/v1/chat/completions", bytes.NewReader(body))
	if err != nil {
		writeErr(w, http.StatusBadGateway, "upstream_error", err.Error())
		return u, http.StatusBadGateway, "", err
	}
	upReq.Header.Set("Content-Type", "application/json")
	upReq.Header.Set("Authorization", "Bearer "+os.Getenv(prov.APIKeyEnv))

	client := &http.Client{Transport: g.transport, Timeout: 10 * time.Minute}
	resp, err := client.Do(upReq)
	if err != nil {
		writeErr(w, http.StatusBadGateway, "upstream_error", err.Error())
		return u, http.StatusBadGateway, "", err
	}
	defer resp.Body.Close()

	for k, vals := range resp.Header {
		for _, v := range vals {
			w.Header().Add(k, v)
		}
	}
	w.WriteHeader(resp.StatusCode)

	if stream && resp.StatusCode == http.StatusOK {
		model := streamPassthrough(w, resp.Body, &u)
		return u, resp.StatusCode, model, nil
	}

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return u, resp.StatusCode, "", err
	}
	_, _ = w.Write(respBody)
	model := parseUsage(respBody, &u)
	if resp.StatusCode >= 400 {
		return u, resp.StatusCode, model, fmt.Errorf("upstream status %d", resp.StatusCode)
	}
	return u, resp.StatusCode, model, nil
}

// streamPassthrough copies SSE chunks to the client while scanning for
// the usage object in the final chunk. Returns the response model.
func streamPassthrough(w http.ResponseWriter, body io.Reader, u *Usage) string {
	flusher, _ := w.(http.Flusher)
	scanner := bufio.NewScanner(body)
	scanner.Buffer(make([]byte, 64*1024), 4<<20)
	model := ""
	for scanner.Scan() {
		line := scanner.Bytes()
		_, _ = w.Write(line)
		_, _ = w.Write([]byte("\n"))
		if flusher != nil {
			flusher.Flush()
		}
		if data, found := bytes.CutPrefix(line, []byte("data: ")); found && !bytes.Equal(data, []byte("[DONE]")) {
			if m := parseUsage(data, u); m != "" {
				model = m
			}
		}
	}
	return model
}

// parseUsage extracts usage and model fields from an OpenAI-compatible
// response or SSE chunk. Returns the model name if present.
func parseUsage(b []byte, u *Usage) string {
	var partial struct {
		Model string `json:"model"`
		Usage *struct {
			PromptTokens        int `json:"prompt_tokens"`
			CompletionTokens    int `json:"completion_tokens"`
			PromptTokensDetails *struct {
				CachedTokens int `json:"cached_tokens"`
			} `json:"prompt_tokens_details"`
			CacheCreationInputTokens int `json:"cache_creation_input_tokens"` // anthropic-compat
			CacheReadInputTokens     int `json:"cache_read_input_tokens"`
		} `json:"usage"`
	}
	if err := json.Unmarshal(b, &partial); err != nil {
		return ""
	}
	if partial.Usage != nil {
		u.InputTokens = partial.Usage.PromptTokens
		u.OutputTokens = partial.Usage.CompletionTokens
		if partial.Usage.PromptTokensDetails != nil {
			u.CacheReadTokens = partial.Usage.PromptTokensDetails.CachedTokens
		}
		if partial.Usage.CacheReadInputTokens > 0 {
			u.CacheReadTokens = partial.Usage.CacheReadInputTokens
		}
		u.CacheWriteTokens = partial.Usage.CacheCreationInputTokens
	}
	return partial.Model
}

// ensureStreamUsage injects stream_options.include_usage=true so the
// provider reports token usage in the final SSE chunk.
func ensureStreamUsage(body []byte) []byte {
	var m map[string]json.RawMessage
	if err := json.Unmarshal(body, &m); err != nil {
		return body
	}
	m["stream_options"] = json.RawMessage(`{"include_usage":true}`)
	out, err := json.Marshal(m)
	if err != nil {
		return body
	}
	return out
}

// ---------- helpers ----------

func (g *Gateway) authenticate(r *http.Request) (*VirtualKey, bool) {
	auth := r.Header.Get("Authorization")
	key, found := strings.CutPrefix(auth, "Bearer ")
	if !found {
		return nil, false
	}
	return g.keys.Lookup(strings.TrimSpace(key))
}

func (g *Gateway) finish(w http.ResponseWriter, ev *LLMCallEvent, start time.Time, status int, code, msg string) {
	ev.LatencyMs = time.Since(start).Milliseconds()
	g.sink.Emit(*ev)
	writeErr(w, status, code, msg)
}

func modelAllowed(vk *VirtualKey, model string) bool {
	if len(vk.AllowedModels) == 0 {
		return true
	}
	for _, m := range vk.AllowedModels {
		if m == model || strings.HasPrefix(model, strings.TrimSuffix(m, "*")) {
			return true
		}
	}
	return false
}

func extractText(req chatRequest) string {
	var sb strings.Builder
	for _, m := range req.Messages {
		var s string
		if err := json.Unmarshal(m.Content, &s); err == nil {
			sb.WriteString(s)
			sb.WriteString("\n")
			continue
		}
		// multimodal content array: collect text parts
		var parts []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		}
		if err := json.Unmarshal(m.Content, &parts); err == nil {
			for _, p := range parts {
				if p.Type == "text" {
					sb.WriteString(p.Text)
					sb.WriteString("\n")
				}
			}
		}
	}
	return sb.String()
}

func redactBody(d *DLPEngine, body []byte) []byte {
	var m map[string]json.RawMessage
	if err := json.Unmarshal(body, &m); err != nil {
		return body
	}
	var msgs []map[string]json.RawMessage
	if err := json.Unmarshal(m["messages"], &msgs); err != nil {
		return body
	}
	for _, msg := range msgs {
		var s string
		if err := json.Unmarshal(msg["content"], &s); err == nil {
			red, _ := json.Marshal(d.Redact(s))
			msg["content"] = red
		}
	}
	if raw, err := json.Marshal(msgs); err == nil {
		m["messages"] = raw
	}
	if out, err := json.Marshal(m); err == nil {
		return out
	}
	return body
}

func hashContent(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:8]) // 64-bit prefix is enough for dedup analytics
}

func maxSeverity(fs []Finding) string {
	rank := map[string]int{"low": 1, "medium": 2, "high": 3, "critical": 4}
	best := ""
	for _, f := range fs {
		if rank[f.Severity] > rank[best] {
			best = f.Severity
		}
	}
	return best
}

func findingClasses(fs []Finding) string {
	var cs []string
	for _, f := range fs {
		cs = append(cs, f.Class)
	}
	return strings.Join(cs, ", ")
}

func writeErr(w http.ResponseWriter, status int, code, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"error": map[string]string{"type": code, "message": msg},
	})
}

var _ = slog.Default // keep slog import if unused in some build tags
