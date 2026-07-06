"""Export & registry tooling for BadgerAI releases.

Two steps, both light (no torch — merging happens in train.finetune --merge):
  card  — render MODEL_CARD.md (base, pinned revision, data version, eval scores,
          license) for a versioned release badger-ai-8b-vX.Y.
  gguf  — convert a merged HF model dir to GGUF Q4_K_M for Ollama dev use (shells
          out to a local llama.cpp checkout; prints setup steps if it is missing).

    python -m export.export card --version v0.1 --eval-json eval.json \
        --run-config out/badger-ai-8b/run_config.json --out out/MODEL_CARD.md
    python -m export.export gguf --model-dir out/badger-ai-8b --llama-cpp ~/llama.cpp \
        --out-dir out/gguf --name badger-ai-8b
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

_TEMPLATE = Path(__file__).parent / "MODEL_CARD.template.md"


def cmd_card(args: argparse.Namespace) -> int:
    tmpl = _TEMPLATE.read_text(encoding="utf-8")
    run_cfg: dict = {}
    if args.run_config and args.run_config.exists():
        run_cfg = json.loads(args.run_config.read_text(encoding="utf-8"))
    eval_scores = "(eval not run)"
    if args.eval_json and args.eval_json.exists():
        eval_scores = args.eval_json.read_text(encoding="utf-8").strip()

    filled = (
        tmpl.replace("{{VERSION}}", args.version)
        .replace("{{BASE_MODEL}}", run_cfg.get("base_model", args.base_model))
        .replace("{{REVISION}}", str(run_cfg.get("revision") or "UNPINNED — pin before release"))
        .replace("{{DATA_VERSION}}", args.data_version)
        .replace("{{LICENSE}}", args.license)
        .replace("{{EVAL_SCORES}}", eval_scores)
    )
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(filled, encoding="utf-8")
    print(f"model card -> {args.out}")
    return 0


def _find_quantize(llama_cpp: Path) -> str | None:
    for cand in (
        llama_cpp / "build" / "bin" / "llama-quantize",
        llama_cpp / "llama-quantize",
        llama_cpp / "quantize",
    ):
        if cand.exists():
            return str(cand)
    return shutil.which("llama-quantize")


def cmd_gguf(args: argparse.Namespace) -> int:
    convert = args.llama_cpp / "convert_hf_to_gguf.py"
    if not convert.exists():
        print(
            "llama.cpp convert_hf_to_gguf.py not found. Point --llama-cpp at a checkout:\n"
            "  git clone https://github.com/ggerganov/llama.cpp && make -C llama.cpp",
            file=sys.stderr,
        )
        return 2

    args.out_dir.mkdir(parents=True, exist_ok=True)
    f16 = args.out_dir / f"{args.name}-f16.gguf"
    subprocess.run(
        [sys.executable, str(convert), str(args.model_dir), "--outfile", str(f16), "--outtype", "f16"],
        check=True,
    )

    quantize = _find_quantize(args.llama_cpp)
    if quantize is None:
        print("llama.cpp quantize binary not found; build llama.cpp (make) first.", file=sys.stderr)
        return 2
    q4 = args.out_dir / f"{args.name}-Q4_K_M.gguf"
    subprocess.run([quantize, str(f16), str(q4), "Q4_K_M"], check=True)
    print(f"gguf (Q4_K_M) -> {q4}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="BadgerAI export & registry tooling.")
    sub = ap.add_subparsers(dest="command", required=True)

    card = sub.add_parser("card", help="render MODEL_CARD.md")
    card.add_argument("--version", required=True, help="release version, e.g. v0.1")
    card.add_argument("--base-model", default="Qwen/Qwen2.5-7B-Instruct")
    card.add_argument("--data-version", default="datagen@seed7")
    card.add_argument("--license", default="Apache-2.0 (base) + internal fine-tune")
    card.add_argument("--eval-json", type=Path, help="eval metrics JSON to embed")
    card.add_argument("--run-config", type=Path, help="run_config.json from finetune")
    card.add_argument("--out", type=Path, default=Path("MODEL_CARD.md"))
    card.set_defaults(func=cmd_card)

    gguf = sub.add_parser("gguf", help="convert merged model to GGUF Q4_K_M")
    gguf.add_argument("--model-dir", type=Path, required=True, help="merged HF model dir")
    gguf.add_argument("--llama-cpp", type=Path, required=True, help="path to a llama.cpp checkout")
    gguf.add_argument("--out-dir", type=Path, default=Path("out/gguf"))
    gguf.add_argument("--name", default="badger-ai-8b")
    gguf.set_defaults(func=cmd_gguf)

    args = ap.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
