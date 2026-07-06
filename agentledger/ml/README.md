# BadgerAI — training pipeline

Makes the risk-enrichment model **ours**: a LoRA fine-tune of a permissive
open-weights base, purpose-trained for BadgerAI's classification task and served
self-hosted. Heavy deps live here and **never** enter the backend/worker images
(see `pyproject.toml` — training deps are the `[train]` extra).

The model's job mirrors the Go worker (`services/workers/internal/riskenrich`):
given the **metadata** of one agent run (ordered tool/MCP-call sequence, MCP
servers, call count — never prompt/completion content), emit governed risk
findings as strict JSON.

## Data boundary (non-negotiable)

The training corpus is **100% synthetic**. `datagen/` fabricates tool-call
sequences from a closed vocabulary and labels them with a deterministic rule
engine — it imports no database client and cannot read a real tenant table. We
never train on real evidence (CLAUDE.md rule 3 / rule 2).

## Layout

```
ml/
  badgerdata/        shared contract, kept in lockstep with the Go worker:
                     prompt.py (system prompt + behavior rendering),
                     schema.py (Finding/Assessment + tolerant parse/validate),
                     guardrails.py (no-invented-content check), vocab.py
  datagen/generate.py  simulator + deterministic labeler → chat JSONL (90/5/5)
  train/finetune.py    QLoRA (transformers+peft+trl), 4-bit NF4  [needs .[train]]
  eval/run_eval.py     ship-gate harness (the CI regression gate)
  export/              export.py (model card + GGUF), MODEL_CARD.template.md, Modelfile
  tests/               pytest (datagen, eval, guardrails, schema, prompt)
```

## Run it

```bash
# 0. dev install (light — datagen/eval/tests, no GPU)
pip install -e '.[dev]'
ruff check . && python -m pytest -q

# 1. synthetic data (>=5000 for a real run; 90/5/5 split, hard negatives in val/test)
python -m datagen.generate --n 5000 --out-dir data --seed 7

# 2. QLoRA fine-tune (GPU box — see sizing below)
pip install -e '.[train]'
python -m train.finetune --data-dir data --output-dir out/badger-ai-8b-lora \
    --base-model Qwen/Qwen2.5-7B-Instruct --revision <PINNED_HF_COMMIT> \
    --merge --merged-dir out/badger-ai-8b

# 3. eval against the held-out test set via a served endpoint (the ship gate)
python -m eval.run_eval --test data/test.jsonl --endpoint http://localhost:8000
#    …or offline against a predictions file (CI): --predictions preds.jsonl

# 4. export
python -m export.export card --version v0.1 --eval-json eval.json \
    --run-config out/badger-ai-8b/run_config.json --out out/MODEL_CARD.md
python -m export.export gguf --model-dir out/badger-ai-8b --llama-cpp ~/llama.cpp \
    --out-dir out/gguf --name badger-ai-8b     # Q4_K_M for Ollama dev
```

## Base model & license

Default base: **Qwen/Qwen2.5-7B-Instruct** (Apache-2.0 — no MAU/usage clauses,
clean for self-hosting). **Pin the exact HF revision** with `--revision`; it is
recorded into `run_config.json` and the model card. `--base-model` accepts any
compatible instruct model (e.g. Llama-3.1-8B-Instruct, whose Community License has
extra terms) — verify license terms before shipping.

## Ship gates (eval — the regression gate on any adapter change)

| Metric | Gate |
|--------|------|
| JSON-valid | ≥ 0.98 |
| Guardrail pass (schema-valid **and** no invented tool/server) | ≥ 0.95 |
| No-invented-content | = 1.00 |

Also reported (non-gating): coverage (top gold category surfaced) and
hard-negative restraint (benign gold → benign prediction). Below any gate → the
harness exits non-zero with a diff report of offending examples.

## Train / inference parity

Training pairs use the **exact** `SYSTEM_PROMPT` and `render_behavior()` the Go
worker sends, and the assistant target is the strict JSON the worker parses. If
the Go prompt/schema changes, change `badgerdata/` to match and re-train — the
`tests/` assert the contract, not just the code.

## GPU sizing

- **Dev (Mac / no GPU):** Ollama with the Q4_K_M GGUF on Apple Silicon
  (`ollama create badger-ai -f export/Modelfile`). Serves the same
  `/v1/chat/completions` surface, so the worker needs no change — just point
  `BADGERIQ_LLM_BASE_URL` at `http://localhost:11434` and set
  `BADGERIQ_LLM_MODEL=badger-ai`.
- **Prod inference:** a single **L4 / A10G-class** GPU (AWS `g6`/`g5.xlarge`)
  serves the 8B comfortably under vLLM (`docker compose --profile llm up
  badger-llm`). Nothing egresses to the internet at inference time.
- **Training off the Mac:** QLoRA fits a single **24GB** GPU. Apple Silicon can't
  run bitsandbytes 4-bit, so fine-tune on a rented GPU — a Colab A100/L4 runtime,
  a Lambda/Runpod on-demand box, or an EC2 `g6.xlarge` spot instance. Copy `data/`
  up, run step 2, copy the merged weights / GGUF back down.
