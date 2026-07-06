# ADR-051 — BadgerAI fine-tune pipeline (synthetic data → QLoRA → eval → export)

**Date:** 2026-07-05
**Status:** Accepted
**Deciders:** Platform team
**Relates to:** ADR-050 (self-hosted inference for risk-enrichment — this produces the model it serves); ADR-030 (the tier's design)

---

## Context

ADR-050 moved risk-enrichment inference onto a self-hosted, OpenAI-compatible
endpoint but left the served model as "any compatible model for dev." To make the
model genuinely **ours** — purpose-trained for the classification task, small
enough to self-host cheaply, and reproducible — we add a training pipeline under a
top-level `ml/` project.

## Decision

A standalone `agentledger/ml/` project with its own `pyproject.toml`. Heavy
training/serving deps (`torch`, `transformers`, `peft`, `trl`, `bitsandbytes`,
`accelerate`, `datasets`) are an **optional `[train]` extra** so they never enter
the backend/worker images; datagen + eval + CI run on light deps
(`numpy`/`pydantic`/`httpx`). Justified per CLAUDE.md rule 3.

### Shared contract, kept in lockstep with the Go worker

`ml/badgerdata/` mirrors `services/workers/internal/riskenrich` exactly: the system
prompt, the `render_behavior()` user format, the Finding/Assessment schema, and the
tolerant parse/validate. Training uses the *same* surface the worker sends at
inference, so we train on what we serve. `tests/` assert this contract.

### 100% synthetic data — never real evidence

`datagen/generate.py` fabricates tool-call sequences from a **closed vocabulary**
and labels them with a **deterministic rule engine** (the ground-truth "engine",
the role the ROI engine played in the original spec). It imports no DB client and
cannot reach a tenant table. Output is chat-format JSONL, 90/5/5 split, with hard
negatives (benign-but-adjacent, single-send, trusted-source, zero-signal)
concentrated in val/test so the model is measured on **restraint**, not just
recall. **Every gold answer is asserted against the guardrail at generation time**
(the risk-classification analog of the ROI engine's dollar-figure `_verify_numbers`
check): a rationale may only name tools/servers present in its behavior — a
template bug that invents content fails the build loudly.

### QLoRA on a permissive base

`train/finetune.py`: 4-bit NF4 QLoRA via `trl.SFTTrainer`, r=16 / alpha=32, cosine
lr 1e-4, bf16, seq 4096, gradient checkpointing — fits a single 24GB GPU. Default
base **Qwen/Qwen2.5-7B-Instruct (Apache-2.0)**; `--base-model` is configurable and
`--revision` PINS the HF commit (recorded into `run_config.json` + the model card).
`--merge` emits merged fp16 safetensors for vLLM.

### Eval is the regression gate

`eval/run_eval.py` scores the held-out test set and enforces ship gates —
**JSON-valid ≥ 0.98, guardrail pass ≥ 0.95, no-invented-content = 1.00** — plus
non-gating coverage and hard-negative restraint. Below any gate it exits non-zero
with a diff report. It runs against a live OpenAI-compatible endpoint or an offline
predictions file (CI uses the offline path on a small sample). Wired into
`agentledger-ci.yml` (the `ml` job: ruff + pytest + datagen(50) + eval gate).

### Export & registry

`export/`: `card` renders `MODEL_CARD.md` (base, pinned revision, data version,
eval scores, license) per release, versioned `badger-ai-8b-vX.Y`; `gguf` converts
the merged model to GGUF Q4_K_M (via a local llama.cpp checkout) for Ollama dev,
with an `export/Modelfile` (ChatML). vLLM consumes the merged safetensors directly.

## Consequences

- BadgerIQ owns its risk model end-to-end: synthetic data → adapter → merged
  weights / GGUF → served locally, no external AI API at train or inference.
- The guardrails that protect a small model (schema re-validation, no-invented
  content, deterministic fallback) are enforced in the worker (ADR-050), asserted
  in the training data, and gated in eval — three independent layers.
- Reproducibility hinges on pinning the base revision; the pipeline records it but
  a release MUST set `--revision`.
- Cost: training is a one-off on a rented 24GB GPU; serving is one L4/A10G. Both
  documented in `ml/README.md`.
- The `ml` CI job is advisory (not one of the required branch-protection checks),
  matching the load/nightly precedent; promote to required once a first trained
  artifact and a stable fixture set exist.
