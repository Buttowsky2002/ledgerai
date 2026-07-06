# BadgerAI {{VERSION}}

Purpose-built classifier for the BadgerIQ semantic risk-enrichment tier. Given the
**metadata** of one agent run (ordered tool/MCP-call sequence, MCP servers, call
count — never prompt/completion content), it emits governed risk findings
(`injection_suspected`, `data_egress`, `privilege_escalation`, `anomalous_sequence`,
or none) as strict JSON. Served self-hosted over an OpenAI-compatible endpoint; no
external AI API is involved at train or inference time.

## Provenance

| Field | Value |
|-------|-------|
| Base model | `{{BASE_MODEL}}` |
| Base revision | `{{REVISION}}` |
| Method | QLoRA (4-bit NF4), r=16 / alpha=32, cosine lr, bf16, seq 4096 |
| Training data | 100% synthetic — `{{DATA_VERSION}}` (see `ml/datagen`; NO real tenant data) |
| License | {{LICENSE}} |

## Eval (held-out synthetic test set)

Ship gates: JSON-valid ≥ 0.98, guardrail pass ≥ 0.95, no-invented-content = 1.00.

```
{{EVAL_SCORES}}
```

## Intended use & limits

- **In scope:** behavioral risk triage over tool-call metadata for the async,
  opt-in enrichment tier. Findings are probabilistic and gated by a confidence
  threshold; the deterministic tier remains authoritative.
- **Out of scope:** any decision on prompt/completion *content* (the model never
  sees it), and any inline/blocking path (this tier is async only).
- **Guardrails:** the worker re-validates every field against the enum/confidence
  bounds and drops invented tools/servers; a malformed generation falls back to an
  empty assessment. Do not remove these — they are load-bearing for a small model.
