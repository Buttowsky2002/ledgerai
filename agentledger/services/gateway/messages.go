package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// Anthropic-native translation.
//
// The gateway's internal canonical request is the OpenAI Chat Completions
// shape (see proxy.go). This file lets Anthropic Messages API clients use the
// gateway unchanged: it translates an incoming /v1/messages request into the
// canonical OpenAI body, runs the shared inline path (serveCanonical), and
// translates the upstream OpenAI response back into the Messages API shape —
// for both buffered JSON and streaming SSE — preserving cache-token accounting.
//
// Per docs/ARCHITECTURE.md §9: "Anthropic-native API translation (Messages API
// ↔ OpenAI format)". Non-text content blocks (images, tool_use) are flattened
// to their text parts for the canonical request; full multimodal/tool-call
// fidelity is out of scope for this phase.

// respFormat selects how a response (success or error) is rendered to the client.
type respFormat int

const (
	formatOpenAI respFormat = iota
	formatAnthropic
)

// ---------- Anthropic request shapes ----------

type anthropicRequest struct {
	Model         string             `json:"model"`
	MaxTokens     int                `json:"max_tokens"`
	System        json.RawMessage    `json:"system,omitempty"` // string OR []contentBlock
	Messages      []anthropicMessage `json:"messages"`
	Stream        bool               `json:"stream,omitempty"`
	Temperature   *float64           `json:"temperature,omitempty"`
	TopP          *float64           `json:"top_p,omitempty"`
	StopSequences []string           `json:"stop_sequences,omitempty"`
	// Tools/MCPServers feed inline tool governance. Both are arrays of objects
	// carrying a "name" (Anthropic tool defs: [{name, input_schema, ...}]; MCP
	// servers: [{name, url, ...}]). We extract only the names for the allowlist
	// check — the canonical body, not these, is what is forwarded upstream.
	Tools      json.RawMessage `json:"tools,omitempty"`
	MCPServers json.RawMessage `json:"mcp_servers,omitempty"`
}

type anthropicMessage struct {
	Role    string          `json:"role"`
	Content json.RawMessage `json:"content"` // string OR []contentBlock
}

// handleMessages is the /v1/messages entry point.
func (g *Gateway) handleMessages(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	snap := g.current.Load()

	// 1. Authenticate virtual key
	vk, ok := g.authenticate(snap, r)
	if !ok {
		writeAnthropicErr(w, http.StatusUnauthorized, "authentication_error",
			"unknown or missing AgentLedger virtual key")
		return
	}

	// 2. Read + parse the Anthropic Messages body (bounded)
	raw, err := io.ReadAll(io.LimitReader(r.Body, 32<<20))
	if err != nil {
		writeAnthropicErr(w, http.StatusBadRequest, "invalid_request_error", "could not read body")
		return
	}
	var areq anthropicRequest
	if err := json.Unmarshal(raw, &areq); err != nil || areq.Model == "" {
		writeAnthropicErr(w, http.StatusBadRequest, "invalid_request_error",
			"body must be a Messages API request with a model")
		return
	}

	// Translate to the canonical OpenAI body, then drive the shared inline path.
	body := translateMessagesToCanonical(areq)
	var req chatRequest
	_ = json.Unmarshal(body, &req) // body is gateway-constructed; always valid

	ev := buildEvent(requestIDFrom(r.Context()), start, vk, r, areq.Model, areq.Stream)
	g.serveCanonical(w, r, snap, vk, body, req, &ev, start, formatAnthropic)
}

// translateMessagesToCanonical converts an Anthropic Messages request into the
// canonical OpenAI Chat Completions body the rest of the gateway understands.
func translateMessagesToCanonical(a anthropicRequest) []byte {
	m := map[string]any{
		"model":  a.Model,
		"stream": a.Stream,
	}
	if a.MaxTokens > 0 {
		m["max_tokens"] = a.MaxTokens
	}
	if a.Temperature != nil {
		m["temperature"] = *a.Temperature
	}
	if a.TopP != nil {
		m["top_p"] = *a.TopP
	}
	if len(a.StopSequences) > 0 {
		m["stop"] = a.StopSequences
	}

	msgs := make([]map[string]any, 0, len(a.Messages)+1)
	if sys := anthropicTextFromRaw(a.System); sys != "" {
		// Anthropic's top-level system prompt maps to an OpenAI system message.
		msgs = append(msgs, map[string]any{"role": "system", "content": sys})
	}
	for _, am := range a.Messages {
		msgs = append(msgs, map[string]any{
			"role":    am.Role,
			"content": anthropicTextFromRaw(am.Content),
		})
	}
	m["messages"] = msgs

	// Carry tool/MCP identifiers into the canonical (OpenAI-shaped) body so the
	// shared inline path's tool governance (proxy.go) sees them. Anthropic tools
	// map to OpenAI function tools; MCP servers map to MCP-type tool entries.
	var tools []map[string]any
	for _, n := range rawObjectNames(a.Tools, "name") {
		tools = append(tools, map[string]any{"type": "function", "function": map[string]any{"name": n}})
	}
	for _, n := range rawObjectNames(a.MCPServers, "name") {
		tools = append(tools, map[string]any{"type": "mcp", "server_label": n})
	}
	if len(tools) > 0 {
		m["tools"] = tools
	}

	out, _ := json.Marshal(m)
	return out
}

// rawObjectNames extracts the string value of `field` from each object in a raw
// JSON array, skipping entries that are not objects or lack the field. Used to
// pull tool/MCP-server names out of an Anthropic request for governance.
func rawObjectNames(raw json.RawMessage, field string) []string {
	if len(raw) == 0 {
		return nil
	}
	var arr []map[string]json.RawMessage
	if err := json.Unmarshal(raw, &arr); err != nil {
		return nil
	}
	var out []string
	for _, o := range arr {
		var s string
		if err := json.Unmarshal(o[field], &s); err == nil && s != "" {
			out = append(out, s)
		}
	}
	return out
}

// anthropicTextFromRaw extracts plain text from an Anthropic content value,
// which may be a bare string or an array of content blocks. Only text blocks
// contribute; other block types (image, tool_use) are skipped.
func anthropicTextFromRaw(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		return s
	}
	var blocks []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if err := json.Unmarshal(raw, &blocks); err == nil {
		var sb strings.Builder
		for _, b := range blocks {
			if b.Type == "text" {
				if sb.Len() > 0 {
					sb.WriteByte('\n')
				}
				sb.WriteString(b.Text)
			}
		}
		return sb.String()
	}
	return ""
}

// ---------- response proxy + translation ----------

// proxyMessages dispatches the canonical request upstream and renders the
// response back to the client in Anthropic Messages format (buffered or SSE),
// capturing usage for cost accounting along the way.
func (g *Gateway) proxyMessages(w http.ResponseWriter, r *http.Request, prov *ProviderCfg, body []byte, stream bool) (Usage, int, string, error) {
	var u Usage
	resp, err := g.dispatchUpstream(r, prov, body, stream)
	if err != nil {
		writeAnthropicErr(w, http.StatusBadGateway, "api_error", err.Error())
		return u, http.StatusBadGateway, "", err
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode >= 400 {
		b, _ := io.ReadAll(resp.Body)
		writeAnthropicErr(w, resp.StatusCode, anthropicErrType(resp.StatusCode, ""), extractOpenAIErrMsg(b))
		return u, resp.StatusCode, "", fmt.Errorf("upstream status %d", resp.StatusCode)
	}

	if stream {
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.WriteHeader(http.StatusOK)
		model := translateStreamOpenAIToAnthropic(w, resp.Body, &u)
		return u, http.StatusOK, model, nil
	}

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return u, resp.StatusCode, "", err
	}
	model := parseUsage(respBody, &u)
	out := translateResponseOpenAIToAnthropic(respBody, u, model)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(out)
	return u, http.StatusOK, model, nil
}

// translateResponseOpenAIToAnthropic converts a buffered OpenAI Chat Completions
// response into an Anthropic Messages response object.
func translateResponseOpenAIToAnthropic(openaiResp []byte, u Usage, model string) []byte {
	var oa struct {
		ID      string `json:"id"`
		Model   string `json:"model"`
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
			FinishReason string `json:"finish_reason"`
		} `json:"choices"`
	}
	_ = json.Unmarshal(openaiResp, &oa)

	content, finish := "", "end_turn"
	if len(oa.Choices) > 0 {
		content = oa.Choices[0].Message.Content
		finish = mapStopReason(oa.Choices[0].FinishReason)
	}
	if model == "" {
		model = oa.Model
	}

	resp := map[string]any{
		"id":            anthropicID(oa.ID),
		"type":          "message",
		"role":          "assistant",
		"model":         model,
		"content":       []any{map[string]any{"type": "text", "text": content}},
		"stop_reason":   finish,
		"stop_sequence": nil,
		"usage":         anthropicUsageMap(u),
	}
	out, _ := json.Marshal(resp)
	return out
}

// translateStreamOpenAIToAnthropic reads OpenAI SSE chunks and emits the
// Anthropic streaming event sequence (message_start → content_block_start →
// content_block_delta* → content_block_stop → message_delta → message_stop),
// while capturing usage into u. Returns the response model.
//
// OpenAI reports usage only in the final chunk, whereas Anthropic carries input
// tokens in message_start; we therefore emit input_tokens=0 at start and the
// authoritative full usage in the closing message_delta. The gateway's own
// cost accounting always uses the captured final usage, so billing is exact.
func translateStreamOpenAIToAnthropic(w http.ResponseWriter, body io.Reader, u *Usage) string {
	flusher, _ := w.(http.Flusher)
	emit := func(event string, payload any) {
		b, _ := json.Marshal(payload)
		_, _ = fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, b)
		if flusher != nil {
			flusher.Flush()
		}
	}

	scanner := bufio.NewScanner(body)
	scanner.Buffer(make([]byte, 64*1024), 4<<20)

	model, msgID, stopReason := "", "", "end_turn"
	started := false
	ensureStarted := func() {
		if started {
			return
		}
		started = true
		if msgID == "" {
			msgID = "msg_stream"
		}
		emit("message_start", map[string]any{
			"type": "message_start",
			"message": map[string]any{
				"id": msgID, "type": "message", "role": "assistant", "model": model,
				"content": []any{}, "stop_reason": nil, "stop_sequence": nil,
				"usage": map[string]any{"input_tokens": 0, "output_tokens": 0},
			},
		})
		emit("content_block_start", map[string]any{
			"type": "content_block_start", "index": 0,
			"content_block": map[string]any{"type": "text", "text": ""},
		})
	}

	for scanner.Scan() {
		data, ok := bytes.CutPrefix(scanner.Bytes(), []byte("data: "))
		if !ok {
			continue
		}
		if bytes.Equal(bytes.TrimSpace(data), []byte("[DONE]")) {
			break
		}
		var chunk struct {
			ID      string `json:"id"`
			Model   string `json:"model"`
			Choices []struct {
				Delta struct {
					Content string `json:"content"`
				} `json:"delta"`
				FinishReason *string `json:"finish_reason"`
			} `json:"choices"`
		}
		if err := json.Unmarshal(data, &chunk); err != nil {
			continue
		}
		if chunk.Model != "" {
			model = chunk.Model
		}
		if chunk.ID != "" && msgID == "" {
			msgID = anthropicID(chunk.ID)
		}
		parseUsage(data, u) // fold usage from whichever chunk carries it

		if len(chunk.Choices) > 0 {
			c := chunk.Choices[0]
			if c.Delta.Content != "" {
				ensureStarted()
				emit("content_block_delta", map[string]any{
					"type": "content_block_delta", "index": 0,
					"delta": map[string]any{"type": "text_delta", "text": c.Delta.Content},
				})
			}
			if c.FinishReason != nil && *c.FinishReason != "" {
				stopReason = mapStopReason(*c.FinishReason)
			}
		}
	}

	// Close out the message even if the completion was empty.
	ensureStarted()
	emit("content_block_stop", map[string]any{"type": "content_block_stop", "index": 0})
	emit("message_delta", map[string]any{
		"type":  "message_delta",
		"delta": map[string]any{"stop_reason": stopReason, "stop_sequence": nil},
		"usage": anthropicUsageMap(*u),
	})
	emit("message_stop", map[string]any{"type": "message_stop"})
	return model
}

// ---------- helpers ----------

// anthropicUsageMap renders the gateway's internal Usage in Anthropic terms.
// OpenAI prompt_tokens includes cached tokens; Anthropic reports input_tokens
// exclusive of cache reads, so we subtract them.
func anthropicUsageMap(u Usage) map[string]any {
	input := u.InputTokens - u.CacheReadTokens
	if input < 0 {
		input = 0
	}
	return map[string]any{
		"input_tokens":                input,
		"output_tokens":               u.OutputTokens,
		"cache_read_input_tokens":     u.CacheReadTokens,
		"cache_creation_input_tokens": u.CacheWriteTokens,
	}
}

// mapStopReason maps OpenAI finish_reason to the Anthropic stop_reason vocabulary.
func mapStopReason(finish string) string {
	switch finish {
	case "length":
		return "max_tokens"
	case "tool_calls", "function_call":
		return "tool_use"
	case "stop", "content_filter", "":
		return "end_turn"
	default:
		return "end_turn"
	}
}

// anthropicID normalizes an upstream id into an Anthropic-style msg_ id.
func anthropicID(id string) string {
	if id == "" {
		return "msg_" + newID("gw")[3:]
	}
	if strings.HasPrefix(id, "msg_") {
		return id
	}
	return "msg_" + strings.TrimPrefix(id, "chatcmpl-")
}

// anthropicErrType maps an HTTP status to an Anthropic error type.
func anthropicErrType(status int, _ string) string {
	switch status {
	case http.StatusUnauthorized:
		return "authentication_error"
	case http.StatusForbidden, http.StatusPaymentRequired:
		return "permission_error"
	case http.StatusTooManyRequests:
		return "rate_limit_error"
	case http.StatusBadRequest:
		return "invalid_request_error"
	case http.StatusNotFound:
		return "not_found_error"
	default:
		return "api_error"
	}
}

// writeErrFmt writes an error response in the client-appropriate format.
func writeErrFmt(w http.ResponseWriter, format respFormat, status int, code, msg string) {
	if format == formatAnthropic {
		writeAnthropicErr(w, status, anthropicErrType(status, code), msg)
		return
	}
	writeErr(w, status, code, msg)
}

// writeAnthropicErr writes an Anthropic Messages API error object.
func writeAnthropicErr(w http.ResponseWriter, status int, etype, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"type":  "error",
		"error": map[string]any{"type": etype, "message": msg},
	})
}

// extractOpenAIErrMsg pulls the human-readable message from an upstream OpenAI
// error body, falling back to a bounded raw string.
func extractOpenAIErrMsg(b []byte) string {
	var e struct {
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(b, &e); err == nil && e.Error.Message != "" {
		return e.Error.Message
	}
	if len(b) > 500 {
		b = b[:500]
	}
	return string(b)
}
