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
	"sync/atomic"
	"time"
)

// Gateway is the OpenAI-compatible reverse proxy: it authenticates virtual keys,
// enforces budgets/rate-limits/DLP, and emits activity events asynchronously.
type Gateway struct {
	current   atomic.Pointer[gatewaySnapshot] // hot-reloadable config; swap atomically
	budgets   BudgetStore
	sink      *EventSink
	transport *http.Transport
}

// newGateway creates a Gateway with an initial snapshot built from cfg and pb.
func newGateway(cfg *Config, pb *PriceBook, budgets BudgetStore, sink *EventSink) *Gateway {
	g := &Gateway{
		budgets:   budgets,
		sink:      sink,
		transport: newUpstreamTransport(),
	}
	g.current.Store(newSnapshotFromCfg(cfg, pb))
	return g
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
	// Tools are the tool/MCP definitions offered to the model. Function tools
	// carry a name under "function"; MCP tools carry a "server_label". Both
	// feed inline tool governance (declaredTools).
	Tools []struct {
		Type        string `json:"type"`
		ServerLabel string `json:"server_label"` // MCP tool: governed server id
		Function    struct {
			Name string `json:"name"`
		} `json:"function"`
	} `json:"tools"`
	// Functions is the legacy OpenAI function-calling field (pre-`tools`).
	Functions []struct {
		Name string `json:"name"`
	} `json:"functions"`
}

// declaredTools returns the tool/MCP identifiers this request exposes to the
// model: function tool names, MCP server labels, and legacy function names.
// These are the identifiers tool governance checks against the agent allowlist.
func (req chatRequest) declaredTools() []string {
	var out []string
	for _, t := range req.Tools {
		if t.Function.Name != "" {
			out = append(out, t.Function.Name)
		}
		if t.ServerLabel != "" {
			out = append(out, t.ServerLabel)
		}
	}
	for _, f := range req.Functions {
		if f.Name != "" {
			out = append(out, f.Name)
		}
	}
	return out
}

func (g *Gateway) handleChatCompletions(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	snap := g.current.Load()

	// 1. Authenticate virtual key
	vk, ok := g.authenticate(snap, r)
	if !ok {
		writeErr(w, http.StatusUnauthorized, "invalid_api_key", "unknown or missing AgentLedger virtual key")
		return
	}

	// 2. Read + parse body (bounded). The OpenAI Chat Completions body is the
	// gateway's internal canonical request format.
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

	ev := buildEvent(requestIDFrom(r.Context()), start, vk, r, req.Model, req.Stream)
	g.serveCanonical(w, r, snap, vk, body, req, &ev, start, formatOpenAI)
}

// buildEvent seeds an LLMCallEvent with attribution + request context shared by
// every inline-path entry point (chat completions and messages).
func buildEvent(callID string, start time.Time, vk *VirtualKey, r *http.Request, model string, stream bool) LLMCallEvent {
	return LLMCallEvent{
		CallID: callID, Timestamp: start.UTC(),
		TenantID: vk.TenantID, TeamID: vk.TeamID, UserID: vk.UserID,
		AppID: vk.AppID, Environment: vk.Environment, VirtualKey: vk.Key,
		AgentID:      r.Header.Get("X-AgentLedger-Agent-Id"),
		RunID:        r.Header.Get("X-AgentLedger-Run-Id"),
		StepID:       r.Header.Get("X-AgentLedger-Step-Id"),
		RequestModel: model, OperationName: "chat", Streamed: stream,
	}
}

// serveCanonical runs inline-path stages 3–9 on an already-parsed canonical
// (OpenAI-format) request. format selects how successful responses and errors
// are rendered to the client (OpenAI passthrough vs Anthropic Messages).
func (g *Gateway) serveCanonical(w http.ResponseWriter, r *http.Request, snap *gatewaySnapshot,
	vk *VirtualKey, body []byte, req chatRequest, ev *LLMCallEvent, start time.Time, format respFormat) {

	// 3. Model allowlist
	if !modelAllowed(vk, req.Model) {
		ev.Status, ev.StatusCode = "blocked_policy", http.StatusForbidden
		g.finishFmt(w, ev, start, http.StatusForbidden, "model_not_allowed",
			fmt.Sprintf("model %q is not allowed for this key", req.Model), format)
		return
	}

	// 3b. Tool/MCP governance — deny-by-default for agents that have an
	// allowlist (ADR-032). Reads only the in-memory snapshot, so it adds zero
	// I/O to the inline path (rule 12). Ungoverned agents and requests without
	// an agent id fall through; the async risk-engine worker still scores them.
	if bad := snap.tools.Disallowed(vk.TenantID, ev.AgentID, req.declaredTools()); len(bad) > 0 {
		ev.Status, ev.StatusCode = "blocked_tool", http.StatusForbidden
		ev.RiskSeverity = "high"
		g.finishFmt(w, ev, start, http.StatusForbidden, "tool_not_allowed",
			"request blocked: agent not permitted to use tool(s): "+strings.Join(bad, ", "), format)
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
		g.finishFmt(w, ev, start, status, reason, "request rejected by AgentLedger policy: "+reason, format)
		return
	}

	// 5. DLP precheck on message content
	promptText := extractText(req)
	ev.PromptHash = hashContent(promptText)
	findings := snap.dlp.Classify(promptText)
	action := snap.dlp.Decide(vk.DLPPolicyID, findings)
	ev.DLPAction, ev.DLPFindings = action, findings
	ev.RiskSeverity = maxSeverity(findings)

	switch action {
	case "block":
		ev.Status, ev.StatusCode = "blocked_dlp", http.StatusForbidden
		g.finishFmt(w, ev, start, http.StatusForbidden, "dlp_blocked",
			"request blocked: sensitive data detected ("+findingClasses(findings)+")", format)
		return
	case "redact":
		body = redactBody(snap.dlp, body)
	}

	// 6. Resolve upstream provider
	prov, ok := snap.cfg.resolveProvider(req.Model)
	if !ok {
		ev.Status, ev.StatusCode = "blocked_policy", http.StatusBadGateway
		g.finishFmt(w, ev, start, http.StatusBadGateway, "no_provider",
			"no upstream configured for model "+req.Model, format)
		return
	}
	ev.Provider = prov.Name

	// 7. Proxy (response rendering depends on the client-facing format)
	var usage Usage
	var status int
	var respModel string
	var err error
	if format == formatAnthropic {
		usage, status, respModel, err = g.proxyMessages(w, r, prov, body, req.Stream)
	} else {
		usage, status, respModel, err = g.proxyUpstream(w, r, prov, body, req.Stream)
	}
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
	ev.CostUSD = snap.prices.Cost(prov.Name, priceModel, usage, start)
	g.budgets.AddSpend(vk.Key, ev.CostUSD)

	// 9. Emit canonical event (async, non-blocking)
	ev.LatencyMs = time.Since(start).Milliseconds()
	g.sink.Emit(*ev)
}

// dispatchUpstream sends the canonical (OpenAI-format) request to the resolved
// provider's /v1/chat/completions endpoint and returns the live response. It is
// shared by the OpenAI passthrough proxy and the Anthropic-translating proxy.
func (g *Gateway) dispatchUpstream(r *http.Request, prov *ProviderCfg, body []byte, stream bool) (*http.Response, error) {
	if stream {
		body = ensureStreamUsage(body)
	}
	upReq, err := http.NewRequestWithContext(r.Context(), "POST",
		strings.TrimRight(prov.BaseURL, "/")+"/v1/chat/completions", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	upReq.Header.Set("Content-Type", "application/json")
	upReq.Header.Set("Authorization", "Bearer "+os.Getenv(prov.APIKeyEnv))
	client := &http.Client{Transport: g.transport, Timeout: 10 * time.Minute}
	return client.Do(upReq)
}

// proxyUpstream forwards the request and captures usage from either the
// JSON response or the final SSE chunks (stream_options.include_usage).
func (g *Gateway) proxyUpstream(w http.ResponseWriter, r *http.Request, prov *ProviderCfg, body []byte, stream bool) (Usage, int, string, error) {
	var u Usage
	resp, err := g.dispatchUpstream(r, prov, body, stream)
	if err != nil {
		writeErr(w, http.StatusBadGateway, "upstream_error", err.Error())
		return u, http.StatusBadGateway, "", err
	}
	defer func() { _ = resp.Body.Close() }()

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

func (g *Gateway) authenticate(snap *gatewaySnapshot, r *http.Request) (*VirtualKey, bool) {
	auth := r.Header.Get("Authorization")
	key, found := strings.CutPrefix(auth, "Bearer ")
	if !found {
		return nil, false
	}
	return snap.keys.Lookup(strings.TrimSpace(key))
}

// finishFmt emits the (terminal) event and writes a format-appropriate error
// response. Used for every inline-path rejection (allowlist, budget, DLP, ...).
func (g *Gateway) finishFmt(w http.ResponseWriter, ev *LLMCallEvent, start time.Time, status int, code, msg string, format respFormat) {
	ev.LatencyMs = time.Since(start).Milliseconds()
	g.sink.Emit(*ev)
	writeErrFmt(w, format, status, code, msg)
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
