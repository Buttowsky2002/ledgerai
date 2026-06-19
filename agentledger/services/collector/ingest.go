package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
)

// Collector wires the ingest HTTP path to the validator and producer.
type Collector struct {
	validator *Validator
	producer  Producer
	metrics   *Metrics
	maxBatch  int

	// OTel GenAI ingest config (see otel.go).
	otelTenantAttr    string
	otelDefaultTenant string
}

// ingestResult summarizes what happened to a request's events.
type ingestResult struct {
	Accepted     int `json:"accepted"`
	RejectedBad  int `json:"rejected_validation"`
	RejectedBusy int `json:"rejected_backpressure"`
}

// handleEvents ingests one event, a JSON array of events, or NDJSON. It never
// blocks: events are validated then handed to the async producer, which
// returns ErrBackpressure (→ 429) rather than waiting when at capacity.
//
// Status: 202 if any event was accepted; 429 if the only failures were
// backpressure; 422 if events parsed but all failed validation; 400 if the
// body could not be parsed at all.
func (c *Collector) handleEvents(w http.ResponseWriter, r *http.Request) {
	c.metrics.RequestsTotal.Add(1)

	body, err := io.ReadAll(r.Body)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "could not read body"})
		return
	}

	events, err := splitEvents(body)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if len(events) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "no events in request"})
		return
	}
	if len(events) > c.maxBatch {
		writeJSON(w, http.StatusRequestEntityTooLarge,
			map[string]string{"error": "too many events in one request"})
		return
	}

	var res ingestResult
	for _, raw := range events {
		var ev map[string]any
		if err := json.Unmarshal(raw, &ev); err != nil {
			res.RejectedBad++
			c.metrics.EventsRejectedValidate.Add(1)
			continue
		}
		if _, err := c.validator.Validate(ev); err != nil {
			res.RejectedBad++
			c.metrics.EventsRejectedValidate.Add(1)
			slog.Debug("event rejected", "err", err)
			continue
		}
		// Produce the original bytes (not the re-encoded map) to preserve the
		// exact payload the producer sent.
		if err := c.producer.TryProduce([]byte(tenantOf(ev)), raw); err != nil {
			if errors.Is(err, ErrBackpressure) {
				res.RejectedBusy++
				c.metrics.EventsRejectedBackpres.Add(1)
				continue
			}
			res.RejectedBad++
			c.metrics.EventsRejectedValidate.Add(1)
			continue
		}
		res.Accepted++
		c.metrics.EventsAccepted.Add(1)
	}

	writeJSON(w, statusFor(res), res)
}

// ingestOutcome is the result of attempting to enqueue one constructed event.
type ingestOutcome int

const (
	outcomeRejected     ingestOutcome = iota // failed validation or produce
	outcomeAccepted                          // validated and enqueued
	outcomeBackpressure                      // producer at capacity (retry later)
)

// produceValidated validates an event built in-process (e.g. mapped from an
// OTLP span) against the canonical schema, then enqueues it. Unlike
// handleEvents — which forwards the caller's original bytes verbatim — this
// re-encodes the constructed map, since there is no original payload to
// preserve. Metrics are updated; the caller maps the outcome to HTTP status.
func (c *Collector) produceValidated(ev map[string]any) ingestOutcome {
	if _, err := c.validator.Validate(ev); err != nil {
		c.metrics.EventsRejectedValidate.Add(1)
		slog.Debug("constructed event rejected", "err", err)
		return outcomeRejected
	}
	raw, err := json.Marshal(ev)
	if err != nil {
		c.metrics.EventsRejectedValidate.Add(1)
		return outcomeRejected
	}
	if err := c.producer.TryProduce([]byte(tenantOf(ev)), raw); err != nil {
		if errors.Is(err, ErrBackpressure) {
			c.metrics.EventsRejectedBackpres.Add(1)
			return outcomeBackpressure
		}
		c.metrics.EventsRejectedValidate.Add(1)
		return outcomeRejected
	}
	c.metrics.EventsAccepted.Add(1)
	return outcomeAccepted
}

// statusFor maps an ingest outcome to an HTTP status code.
func statusFor(res ingestResult) int {
	switch {
	case res.Accepted > 0:
		return http.StatusAccepted // 202
	case res.RejectedBusy > 0:
		return http.StatusTooManyRequests // 429 — retry later
	case res.RejectedBad > 0:
		return http.StatusUnprocessableEntity // 422 — all invalid
	default:
		return http.StatusBadRequest
	}
}

// splitEvents parses a request body that is one JSON object, a JSON array of
// objects, or newline/whitespace-delimited JSON objects (NDJSON).
func splitEvents(body []byte) ([]json.RawMessage, error) {
	trimmed := bytes.TrimSpace(body)
	if len(trimmed) == 0 {
		return nil, nil
	}
	if trimmed[0] == '[' {
		var arr []json.RawMessage
		if err := json.Unmarshal(trimmed, &arr); err != nil {
			return nil, errors.New("invalid JSON array")
		}
		return arr, nil
	}
	// Stream of JSON values (handles a single object and NDJSON alike).
	dec := json.NewDecoder(bytes.NewReader(trimmed))
	var out []json.RawMessage
	for {
		var raw json.RawMessage
		if err := dec.Decode(&raw); err != nil {
			if err == io.EOF {
				break
			}
			return nil, errors.New("invalid JSON event stream")
		}
		out = append(out, raw)
	}
	return out, nil
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
