"""QLoRA fine-tune of an open-weights instruct base into BadgerAI.

Default base: Qwen/Qwen2.5-7B-Instruct (Apache-2.0 — verify at build and PIN the
exact HF revision for reproducibility; --revision records into run_config.json for
the model card). 4-bit NF4 load + LoRA adapters; fits a single 24GB GPU. Trains on
the synthetic chat JSONL from datagen (see ml/README for an off-Mac GPU path).

    pip install -e '.[train]'
    python -m train.finetune --data-dir data --output-dir out/badger-ai-8b-lora \
        --revision <pinned-hf-commit> --merge --merged-dir out/badger-ai-8b
"""

from __future__ import annotations

import argparse
import json
import warnings
from pathlib import Path

import torch
from datasets import load_dataset
from peft import LoraConfig, prepare_model_for_kbit_training
from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig
from trl import SFTConfig, SFTTrainer

DEFAULT_BASE = "Qwen/Qwen2.5-7B-Instruct"  # Apache-2.0
LORA_TARGETS = ["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"]


def build_args() -> argparse.Namespace:
    ap = argparse.ArgumentParser(description="QLoRA fine-tune BadgerAI.")
    ap.add_argument("--base-model", default=DEFAULT_BASE)
    ap.add_argument("--revision", default=None, help="PIN the exact HF commit for reproducible builds")
    ap.add_argument("--data-dir", type=Path, default=Path("data"))
    ap.add_argument("--output-dir", type=Path, default=Path("out/badger-ai-8b-lora"))
    ap.add_argument("--epochs", type=float, default=3.0)
    ap.add_argument("--lr", type=float, default=1e-4)
    ap.add_argument("--lora-r", type=int, default=16)
    ap.add_argument("--lora-alpha", type=int, default=32)
    ap.add_argument("--lora-dropout", type=float, default=0.05)
    ap.add_argument("--max-seq-len", type=int, default=4096)
    ap.add_argument("--batch-size", type=int, default=1)
    ap.add_argument("--grad-accum", type=int, default=16)
    ap.add_argument("--merge", action="store_true", help="also save merged fp16 weights (for vLLM)")
    ap.add_argument("--merged-dir", type=Path, default=Path("out/badger-ai-8b"))
    return ap.parse_args()


def load_tokenizer(base: str, revision: str | None) -> AutoTokenizer:
    tok = AutoTokenizer.from_pretrained(base, revision=revision, use_fast=True)
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token
    return tok


def format_dataset(data_dir: Path, tokenizer: AutoTokenizer):
    files = {"train": str(data_dir / "train.jsonl"), "validation": str(data_dir / "val.jsonl")}
    ds = load_dataset("json", data_files=files)

    def to_text(row: dict) -> dict:
        text = tokenizer.apply_chat_template(row["messages"], tokenize=False, add_generation_prompt=False)
        return {"text": text}

    return ds.map(to_text, remove_columns=ds["train"].column_names)


def main() -> None:
    args = build_args()
    if args.revision is None:
        warnings.warn("No --revision pinned; builds will not be reproducible. Pin the HF commit.", stacklevel=1)

    tokenizer = load_tokenizer(args.base_model, args.revision)
    ds = format_dataset(args.data_dir, tokenizer)

    quant = BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_quant_type="nf4",
        bnb_4bit_compute_dtype=torch.bfloat16,
        bnb_4bit_use_double_quant=True,
    )
    model = AutoModelForCausalLM.from_pretrained(
        args.base_model,
        revision=args.revision,
        quantization_config=quant,
        torch_dtype=torch.bfloat16,
        device_map="auto",
    )
    model.config.use_cache = False
    model = prepare_model_for_kbit_training(model, use_gradient_checkpointing=True)

    peft_config = LoraConfig(
        r=args.lora_r,
        lora_alpha=args.lora_alpha,
        lora_dropout=args.lora_dropout,
        bias="none",
        task_type="CAUSAL_LM",
        target_modules=LORA_TARGETS,
    )

    sft_config = SFTConfig(
        output_dir=str(args.output_dir),
        num_train_epochs=args.epochs,
        learning_rate=args.lr,
        lr_scheduler_type="cosine",
        warmup_ratio=0.03,
        per_device_train_batch_size=args.batch_size,
        gradient_accumulation_steps=args.grad_accum,
        gradient_checkpointing=True,
        bf16=True,
        max_seq_length=args.max_seq_len,
        dataset_text_field="text",
        packing=False,
        logging_steps=10,
        save_strategy="epoch",
        eval_strategy="epoch",
        report_to="none",
    )

    trainer = SFTTrainer(
        model=model,
        args=sft_config,
        train_dataset=ds["train"],
        eval_dataset=ds["validation"],
        peft_config=peft_config,
        processing_class=tokenizer,
    )
    trainer.train()

    args.output_dir.mkdir(parents=True, exist_ok=True)
    trainer.save_model(str(args.output_dir))
    tokenizer.save_pretrained(str(args.output_dir))

    run_config = {
        "base_model": args.base_model,
        "revision": args.revision,
        "epochs": args.epochs,
        "lr": args.lr,
        "lora": {"r": args.lora_r, "alpha": args.lora_alpha, "dropout": args.lora_dropout},
        "max_seq_len": args.max_seq_len,
    }
    (args.output_dir / "run_config.json").write_text(json.dumps(run_config, indent=2), encoding="utf-8")

    if args.merge:
        merged = trainer.model.merge_and_unload()
        args.merged_dir.mkdir(parents=True, exist_ok=True)
        merged.save_pretrained(str(args.merged_dir), safe_serialization=True)
        tokenizer.save_pretrained(str(args.merged_dir))
        (args.merged_dir / "run_config.json").write_text(json.dumps(run_config, indent=2), encoding="utf-8")
        print(f"merged weights -> {args.merged_dir}")

    print(f"adapter -> {args.output_dir}")


if __name__ == "__main__":
    main()
