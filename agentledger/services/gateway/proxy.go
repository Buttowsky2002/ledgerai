package main

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
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
	metrics   *Metrics
	ops       opsAuthConfig // auth for /v1/usage and /metrics (set in main)
	budgetCfg budgetConfig  // budget reservation tunables (set in main)
}

// newGateway creates a Gateway with an initial snapshot built from cfg and pb.
func newGateway(cfg *Config, pb *PriceBook, budgets BudgetStore, sink *EventSink) *Gateway {
	g := &Gateway{
		budgets:   budgets,
		sink:      sink,
		transport: newUpstreamTransport(),
		metrics:   NewMetrics(),
		// Sensible default; main() overrides from the environment via loadBudgetConfig.
		budgetCfg: budgetConfig{defaultReserveUSD: defaultReserveFallbackUSD},
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
	Model     string `json:"model"`
	Stream    bool   `json:"stream"`
	MaxTokens int    `json:"max_tokens"` // upper bound on output tokens; feeds the budget estimate
	Messages  []struct {
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
		AppID: vk.AppID, Environment: vk.Environment, VirtualKey: vk.KeyID,
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

	// 4. DLP precheck on message content. Runs before any budget hold so a
	// blocked request never reserves budget.
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

	// 5. Resolve upstream provider (needed to price the reservation estimate).
	prov, ok := snap.cfg.resolveProvider(req.Model)
	if !ok {
		ev.Status, ev.StatusCode = "blocked_policy", http.StatusBadGateway
		g.finishFmt(w, ev, start, http.StatusBadGateway, "no_provider",
			"no upstream configured for model "+req.Model, format)
		return
	}
	ev.Provider = prov.Name

	// 6. Budget reservation: hold a conservative estimate before the upstream
	// call. Committed to the actual cost on success, released if no billable
	// call occurred. Reserve also enforces the per-minute rate limit.
	estimate := g.estimateReserveUSD(snap, prov, req.Model, req.MaxTokens, len(promptText), start)
	res, ok, reason := g.budgets.Reserve(vk, estimate)
	if !ok {
		status := http.StatusTooManyRequests
		ev.Status = "blocked_rate"
		switch reason {
		case "monthly_budget_exceeded":
			status, ev.Status = http.StatusPaymentRequired, "blocked_budget"
		case "budget_unavailable":
			status, ev.Status = http.StatusServiceUnavailable, "blocked_budget"
		}
		ev.StatusCode = status
		g.finishFmt(w, ev, start, status, reason, "request rejected by AgentLedger policy: "+reason, format)
		return
	}

	// 7. Proxy (response rendering depends on the client-facing format). The
	// dispatch window [preDispatch, postDispatch] is the upstream round-trip and is
	// subtracted from total inline time to yield policy overhead (stage 9).
	var usage Usage
	var status int
	var respModel string
	var err error
	preDispatch := time.Now()
	if format == formatAnthropic {
		usage, status, respModel, err = g.proxyMessages(w, r, prov, body, req.Stream)
	} else {
		usage, status, respModel, err = g.proxyUpstream(w, r, prov, body, req.Stream)
	}
	postDispatch := time.Now()
	ev.StatusCode = status
	ev.ResponseModel = respModel
	ev.InputTokens, ev.OutputTokens = usage.InputTokens, usage.OutputTokens
	ev.CacheReadTokens, ev.CacheWriteTokens = usage.CacheReadTokens, usage.CacheWriteTokens

	// 8. Settle the reservation: commit to the realized cost on success, or
	// release the hold when the upstream call produced no billable usage.
	if err != nil {
		// A failed client write is the gateway's egress fault, not the upstream's;
		// distinguish it so events are diagnosable.
		if errors.Is(err, errClientWrite) {
			ev.Status = "client_error"
		} else {
			ev.Status = "upstream_error"
		}
		g.budgets.Release(res)
	} else {
		ev.Status = "ok"
		priceModel := respModel
		if priceModel == "" {
			priceModel = req.Model
		}
		ev.CostUSD = snap.prices.Cost(prov.Name, priceModel, usage, start)
		g.budgets.Commit(res, ev.CostUSD)
	}

	// 9. Emit canonical event (async, non-blocking)
	ev.LatencyMs = time.Since(start).Milliseconds()
	g.sink.Emit(*ev)

	// Policy overhead = inline time minus the upstream round-trip.
	overhead := preDispatch.Sub(start) + time.Since(postDispatch)
	g.metrics.Observe(float64(overhead.Microseconds())/1000.0, statusClass(ev.Status))
}

// estimateReserveUSD computes a conservative budget hold for a request. With a
// max_tokens cap it prices those as output tokens (the most expensive rate) plus
// a rough estimate of the prompt's input tokens (~4 chars/token). Without
// max_tokens it falls back to the configured default reserve.
func (g *Gateway) estimateReserveUSD(snap *gatewaySnapshot, prov *ProviderCfg, model string, maxTokens, promptChars int, at time.Time) float64 {
	if maxTokens <= 0 {
		return g.budgetCfg.defaultReserveUSD
	}
	outRate, _ := snap.prices.Rate(prov.Name, model, "output", at)
	inRate, _ := snap.prices.Rate(prov.Name, model, "input", at)
	est := outRate*float64(maxTokens)/1_000_000 + inRate*float64(promptChars/4)/1_000_000
	if est <= 0 {
		return g.budgetCfg.defaultReserveUSD
	}
	return est
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
		model, serr := streamPassthrough(w, resp.Body, &u)
		return u, resp.StatusCode, model, serr
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

// Streaming copy errors, surfaced so the gateway event reflects the failure.
var (
	errUpstreamRead = errors.New("upstream stream read error")
	errClientWrite  = errors.New("client stream write error")
)

// streamPassthrough copies SSE chunks from the upstream body to the client,
// capturing usage from data chunks. It returns the response model and an error:
//   - nil when the stream completes normally (upstream EOF);
//   - errUpstreamRead if reading the upstream failed mid-stream (not EOF);
//   - errClientWrite if writing to the client failed.
//
// It reads with bufio.Reader.ReadBytes('\n') rather than bufio.Scanner so an
// arbitrarily long SSE line never trips a scanner token-size limit.
func streamPassthrough(w http.ResponseWriter, body io.Reader, u *Usage) (string, error) {
	flusher, _ := w.(http.Flusher)
	reader := bufio.NewReader(body)
	model := ""
	for {
		line, readErr := reader.ReadBytes('\n')
		if len(line) > 0 {
			// Forward the bytes exactly as received (newline included).
			if _, werr := w.Write(line); werr != nil {
				return model, fmt.Errorf("%w: %w", errClientWrite, werr)
			}
			if flusher != nil {
				flusher.Flush()
			}
			if data, found := bytes.CutPrefix(bytes.TrimRight(line, "\r\n"), []byte("data: ")); found && !bytes.Equal(data, []byte("[DONE]")) {
				if m := parseUsage(data, u); m != "" {
					model = m
				}
			}
		}
		if readErr != nil {
			if readErr == io.EOF {
				return model, nil // normal end of stream
			}
			return model, fmt.Errorf("%w: %w", errUpstreamRead, readErr)
		}
	}
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
	// An early rejection never reached the upstream, so the whole elapsed time is
	// policy overhead.
	g.metrics.Observe(float64(time.Since(start).Microseconds())/1000.0, statusClass(ev.Status))
	writeErrFmt(w, format, status, code, msg)
}

// modelAllowed reports whether model is permitted for vk. An empty allowlist
// permits everything. Each pattern is whitespace-trimmed; blank patterns are
// ignored. A pattern ending in "*" matches by prefix (the text before the "*");
// any other pattern requires an exact match — so an exact entry like "gpt-4o"
// never accidentally admits "gpt-4o-mini".
func modelAllowed(vk *VirtualKey, model string) bool {
	if len(vk.AllowedModels) == 0 {
		return true
	}
	for _, raw := range vk.AllowedModels {
		pat := strings.TrimSpace(raw)
		if pat == "" {
			continue // ignore empty / whitespace-only patterns
		}
		if prefix, isWildcard := strings.CutSuffix(pat, "*"); isWildcard {
			if strings.HasPrefix(model, prefix) {
				return true
			}
			continue
		}
		if pat == model {
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

// redactBody rewrites sensitive spans in an OpenAI-style chat body in place,
// covering the same content shapes the detector (extractText) reads: a message's
// `content` may be a plain string or an array of parts, where only `text` parts
// are redacted and every other part (e.g. image_url) is preserved byte-for-byte.
// Valid JSON structure is preserved. If the body cannot be parsed it is returned
// unchanged, with a debug-level note that carries no raw content.
func redactBody(d *DLPEngine, body []byte) []byte {
	var top map[string]json.RawMessage
	if err := json.Unmarshal(body, &top); err != nil {
		slog.Debug("dlp redact skipped: request body is not a JSON object; passing through unredacted")
		return body
	}
	rawMsgs, ok := top["messages"]
	if !ok {
		return body
	}
	var msgs []json.RawMessage
	if err := json.Unmarshal(rawMsgs, &msgs); err != nil {
		slog.Debug("dlp redact skipped: messages is not a JSON array; passing through unredacted")
		return body
	}

	changed := false
	for i, rawMsg := range msgs {
		var msg map[string]json.RawMessage
		if err := json.Unmarshal(rawMsg, &msg); err != nil {
			continue // leave a malformed message untouched
		}
		content, ok := msg["content"]
		if !ok {
			continue
		}
		newContent, ok := redactContent(d, content)
		if !ok {
			continue
		}
		msg["content"] = newContent
		if remarshaled, err := json.Marshal(msg); err == nil {
			msgs[i] = remarshaled
			changed = true
		}
	}
	if !changed {
		return body
	}
	if raw, err := json.Marshal(msgs); err == nil {
		top["messages"] = raw
	}
	if out, err := json.Marshal(top); err == nil {
		return out
	}
	return body
}

// redactContent redacts a message's `content`, which may be a plain string or an
// array of content parts. Non-text parts are preserved unchanged. It returns the
// new content and whether it should replace the original (false = leave as-is).
func redactContent(d *DLPEngine, content json.RawMessage) (json.RawMessage, bool) {
	// Case 1: content is a plain string.
	var s string
	if err := json.Unmarshal(content, &s); err == nil {
		red, err := json.Marshal(d.Redact(s))
		if err != nil {
			return nil, false
		}
		return red, true
	}

	// Case 2: content is an array of parts.
	var parts []json.RawMessage
	if err := json.Unmarshal(content, &parts); err != nil {
		return nil, false // neither string nor array — leave unchanged
	}
	changed := false
	for i, rawPart := range parts {
		var part map[string]json.RawMessage
		if err := json.Unmarshal(rawPart, &part); err != nil {
			continue // not an object — preserve unchanged
		}
		var typ string
		if err := json.Unmarshal(part["type"], &typ); err != nil || typ != "text" {
			continue // non-text part (e.g. image_url) preserved unchanged
		}
		var txt string
		if err := json.Unmarshal(part["text"], &txt); err != nil {
			continue // missing/non-string text — preserve unchanged
		}
		red, err := json.Marshal(d.Redact(txt))
		if err != nil {
			continue
		}
		part["text"] = red
		if remarshaled, err := json.Marshal(part); err == nil {
			parts[i] = remarshaled // only this part changes; others keep their bytes
			changed = true
		}
	}
	if !changed {
		return nil, false
	}
	if raw, err := json.Marshal(parts); err == nil {
		return raw, true
	}
	return nil, false
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
