"""Synthetic training-data generator for BadgerAI.

100% SYNTHETIC BY CONSTRUCTION. This module fabricates agent tool-call sequences
from a closed vocabulary and labels them with a DETERMINISTIC rule engine
(label_behavior) that plays the role the ROI engine plays in the original spec:
it is the ground truth. It imports nothing that can reach a real tenant table —
there is no database client here, by design (CLAUDE.md rule 3: never train on real
evidence).

Pipeline: simulate diverse behaviors (varied org sizes / adoption / injected
archetypes) -> deterministically label -> compose a hedged gold Assessment using
ONLY tool/server names present in the behavior -> assert the guardrail on every
gold answer -> emit chat-format JSONL with a 90/5/5 split, hard negatives
concentrated in val/test.

    python -m datagen.generate --n 5000 --out-dir data --seed 7
"""

from __future__ import annotations

import argparse
import json
import random
from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path

from badgerdata import (
    SYSTEM_PROMPT,
    Assessment,
    Finding,
    assessment_guardrail_ok,
    render_behavior,
)
from badgerdata.vocab import (
    BENIGN_TOOLS,
    EXFIL_TOOLS,
    MCP_TOOLS,
    PRIVILEGE_TOOLS,
    READ_SENSITIVE_TOOLS,
    TRUSTED_MCP,
    UNTRUSTED_MCP,
    is_untrusted_mcp,
    tool_kind,
)

# Reads/privilege tools that are "sensitive-heavy" → bump severity to high.
_HIGH_SENSITIVITY_READS = {"read_secret_store", "export_table", "list_customers", "query_crm"}
_HIGH_PRIVILEGE = {"sudo_exec", "modify_iam_policy", "escalate_privilege", "grant_role"}

_HEDGES = ("estimated", "~", "likely", "appears to be", "suggests a possible")


@dataclass
class Behavior:
    agent_id: str
    run_id: str
    tools: list[str] = field(default_factory=list)
    mcp_servers: list[str] = field(default_factory=list)

    @property
    def call_count(self) -> int:
        return len(self.tools)

    def present_tokens(self) -> set[str]:
        return set(self.tools) | set(self.mcp_servers)


# ----------------------------------------------------------------------------- #
# Deterministic label engine (ground truth). Given tools + mcp servers, emit the
# single strongest finding, or none. First matching rule wins.
# ----------------------------------------------------------------------------- #
def _first_index(tools: Sequence[str], kinds: set[str]) -> int | None:
    for i, t in enumerate(tools):
        if tool_kind(t) in kinds:
            return i
    return None


def _first_index_in(tools: Sequence[str], names: set[str]) -> int | None:
    for i, t in enumerate(tools):
        if t in names:
            return i
    return None


def label_behavior(b: Behavior) -> Assessment:
    tools = b.tools
    has_untrusted = any(is_untrusted_mcp(s) for s in b.mcp_servers)

    mcp_read_idx = _first_index_in(tools, set(MCP_TOOLS))
    read_idx = _first_index(tools, {"read_sensitive"})
    exfil_idx = _first_index(tools, {"exfil"})
    priv_idx = _first_index(tools, {"privilege"})
    n_exfil = sum(1 for t in tools if tool_kind(t) == "exfil")

    # 1. injection_suspected: untrusted MCP read then an exfil-shaped call.
    if has_untrusted and mcp_read_idx is not None and exfil_idx is not None and exfil_idx > mcp_read_idx:
        server = next(s for s in b.mcp_servers if is_untrusted_mcp(s))
        mcp_tool = tools[mcp_read_idx]
        exfil_tool = tools[exfil_idx]
        adjacent = exfil_idx == mcp_read_idx + 1
        conf = 0.82 if adjacent else 0.66
        return _one("injection_suspected", "high", conf, b,
                    _injection_rationale(server, mcp_tool, exfil_tool))

    # 2. data_egress: sensitive read then external send.
    if read_idx is not None and exfil_idx is not None and exfil_idx > read_idx:
        read_tool = tools[read_idx]
        exfil_tool = tools[exfil_idx]
        adjacent = exfil_idx == read_idx + 1
        high = read_tool in _HIGH_SENSITIVITY_READS
        conf = (0.86 if adjacent else 0.62) + (0.04 if high else 0.0)
        return _one("data_egress", "high" if high else "medium", min(conf, 0.95), b,
                    _egress_rationale(read_tool, exfil_tool))

    # 3. privilege_escalation: a privilege tool acquired/used mid-run.
    if priv_idx is not None and b.call_count >= 2:
        priv_tool = tools[priv_idx]
        high = priv_tool in _HIGH_PRIVILEGE
        return _one("privilege_escalation", "high" if high else "medium", 0.74, b,
                    _privilege_rationale(priv_tool))

    # 4. anomalous_sequence: repeated external sends (a single send is common/benign
    #    and left unflagged so the model learns restraint on hard negatives).
    if n_exfil >= 2:
        exfil_tool = tools[exfil_idx] if exfil_idx is not None else EXFIL_TOOLS[0]
        return _one("anomalous_sequence", "medium", 0.55, b,
                    _anomalous_rationale(exfil_tool, n_exfil))

    # 5. benign.
    return Assessment(findings=[])


def _one(category: str, severity: str, confidence: float, b: Behavior, rationale: str) -> Assessment:
    return Assessment(findings=[Finding(
        category=category, severity=severity, confidence=round(confidence, 2), rationale=rationale,
    )])


# ----------------------------------------------------------------------------- #
# Rationale templates — varied phrasing, ALWAYS hedged, and referencing ONLY names
# present in the behavior (so the no-invented-content guardrail passes).
# ----------------------------------------------------------------------------- #
def _rng_hedge(rng: random.Random) -> str:
    return rng.choice(_HEDGES)


# Templates are (chosen at emit time via a per-example rng seeded by run_id) but the
# label engine is deterministic, so we thread a small local rng derived from names.
def _seeded(*parts: str) -> random.Random:
    return random.Random("|".join(parts))


def _injection_rationale(server: str, mcp_tool: str, exfil_tool: str) -> str:
    rng = _seeded("inj", server, mcp_tool, exfil_tool)
    hedge = _rng_hedge(rng)
    templates = [
        f"untrusted MCP {server} read via {mcp_tool} then {exfil_tool} {hedge} an injection-driven exfiltration",
        f"{mcp_tool} against {server} immediately preceding {exfil_tool} {hedge} tool_result-sourced injection",
        f"untrusted {server} content read by {mcp_tool} followed by {exfil_tool} {hedge} an injection-driven send",
    ]
    return rng.choice(templates)


def _egress_rationale(read_tool: str, exfil_tool: str) -> str:
    rng = _seeded("egr", read_tool, exfil_tool)
    hedge = _rng_hedge(rng)
    templates = [
        f"{read_tool} of sensitive data followed by {exfil_tool} {hedge} an external send of collected data",
        f"collection via {read_tool} then {exfil_tool} {hedge} data egress",
        f"{read_tool} then {exfil_tool} {hedge} sensitive data leaving over an external channel",
    ]
    return rng.choice(templates)


def _privilege_rationale(priv_tool: str) -> str:
    rng = _seeded("priv", priv_tool)
    hedge = _rng_hedge(rng)
    templates = [
        f"use of {priv_tool} mid-run {hedge} privilege escalation",
        f"{priv_tool} acquired during the run {hedge} an escalation of privilege",
        f"mid-run {priv_tool} {hedge} the agent gained higher privilege",
    ]
    return rng.choice(templates)


def _anomalous_rationale(exfil_tool: str, n_exfil: int) -> str:
    rng = _seeded("anom", exfil_tool, str(n_exfil))
    hedge = _rng_hedge(rng)
    templates = [
        f"repeated external sends including {exfil_tool} {hedge} an unusual egress pattern",
        f"{exfil_tool} used without a preceding read {hedge} an anomalous sequence",
        f"multiple sends via {exfil_tool} {hedge} an unsafe combination of tools",
    ]
    return rng.choice(templates)


# ----------------------------------------------------------------------------- #
# Simulator — archetype behaviors across varied org sizes / adoption patterns.
# ----------------------------------------------------------------------------- #
def _pad_benign(rng: random.Random, tools: list[str], lo: int, hi: int) -> list[str]:
    """Sprinkle benign tools around a core sequence to vary length / realism."""
    out = list(tools)
    for _ in range(rng.randint(lo, hi)):
        out.insert(rng.randint(0, len(out)), rng.choice(BENIGN_TOOLS))
    return out


def _ids(rng: random.Random) -> tuple[str, str]:
    org = rng.randint(1, 40)
    return f"agent_{org:02d}_{rng.randint(1, 9)}", f"run_{rng.randrange(16**8):08x}"


def gen_benign(rng: random.Random) -> Behavior:
    a, r = _ids(rng)
    tools = _pad_benign(rng, [rng.choice(BENIGN_TOOLS)], 1, 4)
    mcp = [rng.choice(TRUSTED_MCP)] if rng.random() < 0.4 else []
    return Behavior(a, r, tools, mcp)


def gen_data_egress(rng: random.Random) -> Behavior:
    a, r = _ids(rng)
    read = rng.choice(READ_SENSITIVE_TOOLS)
    exfil = rng.choice(EXFIL_TOOLS)
    core = [read, exfil] if rng.random() < 0.6 else [read, rng.choice(BENIGN_TOOLS), exfil]
    return Behavior(a, r, _pad_benign(rng, core, 0, 3), [])


def gen_injection(rng: random.Random) -> Behavior:
    a, r = _ids(rng)
    mcp_tool = rng.choice(MCP_TOOLS)
    exfil = rng.choice(EXFIL_TOOLS)
    core = [mcp_tool, exfil] if rng.random() < 0.6 else [mcp_tool, rng.choice(BENIGN_TOOLS), exfil]
    server = rng.choice(UNTRUSTED_MCP)
    return Behavior(a, r, _pad_benign(rng, core, 0, 2), [server])


def gen_privilege(rng: random.Random) -> Behavior:
    a, r = _ids(rng)
    priv = rng.choice(PRIVILEGE_TOOLS)
    core = [rng.choice(BENIGN_TOOLS), priv]
    return Behavior(a, r, _pad_benign(rng, core, 0, 3), [])


def gen_anomalous(rng: random.Random) -> Behavior:
    a, r = _ids(rng)
    e1, e2 = rng.sample(EXFIL_TOOLS, 2)
    core = [e1, rng.choice(BENIGN_TOOLS), e2]
    return Behavior(a, r, _pad_benign(rng, core, 0, 2), [])


# Hard negatives: look risky, are benign under the rules — teach the model restraint.
def gen_hard_negative(rng: random.Random) -> Behavior:
    a, r = _ids(rng)
    kind = rng.randint(0, 3)
    if kind == 0:  # sensitive read but NO external send
        tools = _pad_benign(rng, [rng.choice(READ_SENSITIVE_TOOLS)], 1, 3)
        return Behavior(a, r, tools, [])
    if kind == 1:  # trusted MCP fetch then a send (trusted source → not injection)
        tools = [rng.choice(MCP_TOOLS), rng.choice(EXFIL_TOOLS)]
        return Behavior(a, r, _pad_benign(rng, tools, 0, 2), [rng.choice(TRUSTED_MCP)])
    if kind == 2:  # single tool, zero signal
        return Behavior(a, r, [rng.choice(BENIGN_TOOLS)], [])
    # all-benign but long (adoption-heavy agent)
    return Behavior(a, r, _pad_benign(rng, [rng.choice(BENIGN_TOOLS)], 4, 8), [])


_RISKY = (gen_data_egress, gen_injection, gen_privilege, gen_anomalous)


def to_chat_example(b: Behavior, a: Assessment) -> dict:
    user = render_behavior(b.agent_id, b.run_id, b.tools, b.mcp_servers, b.call_count)
    # ~20% of benign answers use the explicit {"category":"none"} form the prompt allows.
    return {
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user},
            {"role": "assistant", "content": a.model_dump_json()},
        ]
    }


def _maybe_none_form(b: Behavior, a: Assessment, rng: random.Random) -> Assessment:
    if a.findings:
        return a
    if rng.random() < 0.2:
        return Assessment(findings=[Finding(
            category="none", severity="low", confidence=0.1,
            rationale="benign tool sequence, no risk pattern (estimated)",
        )])
    return a


def generate_dataset(
    n: int, seed: int, val_frac: float = 0.05, test_frac: float = 0.05, hard_neg_frac: float = 0.18
) -> dict[str, list[dict]]:
    rng = random.Random(seed)
    n_test = max(1, int(n * test_frac))
    n_val = max(1, int(n * val_frac))
    n_train = n - n_val - n_test

    def make(count: int, hard_neg: bool) -> list[dict]:
        out: list[dict] = []
        for _ in range(count):
            if hard_neg and rng.random() < hard_neg_frac:
                b = gen_hard_negative(rng)
            else:
                # Mixed traffic: mostly benign, the rest spread across risk archetypes.
                b = gen_benign(rng) if rng.random() < 0.45 else rng.choice(_RISKY)(rng)
            a = _maybe_none_form(b, label_behavior(b), rng)
            ok, violations = assessment_guardrail_ok(a, b.present_tokens())
            if not ok:  # fail loud — a template bug must never ship into training data
                raise AssertionError(f"gold answer violates guardrail: {violations} for {b}")
            out.append(to_chat_example(b, a))
        return out

    # Hard negatives concentrated in val/test so the model is measured on restraint.
    return {
        "train": make(n_train, hard_neg=False),
        "val": make(n_val, hard_neg=True),
        "test": make(n_test, hard_neg=True),
    }


def write_splits(splits: dict[str, list[dict]], out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    for name, rows in splits.items():
        path = out_dir / f"{name}.jsonl"
        with path.open("w", encoding="utf-8") as fh:
            for row in rows:
                fh.write(json.dumps(row, ensure_ascii=False) + "\n")
        print(f"wrote {len(rows):>6} examples -> {path}")


def main() -> None:
    ap = argparse.ArgumentParser(description="Generate synthetic BadgerAI training data.")
    ap.add_argument("--n", type=int, default=5000, help="total examples (>=5000 for a real run)")
    ap.add_argument("--out-dir", type=Path, default=Path("data"))
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--val-frac", type=float, default=0.05)
    ap.add_argument("--test-frac", type=float, default=0.05)
    args = ap.parse_args()

    splits = generate_dataset(args.n, args.seed, args.val_frac, args.test_frac)
    write_splits(splits, args.out_dir)


if __name__ == "__main__":
    main()
