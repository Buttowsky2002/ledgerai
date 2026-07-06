"""Tool / MCP-server vocabulary shared by the simulator and the guardrails.

This is a *closed* vocabulary: the synthetic simulator only ever emits names from
here, and the no-invented-content guardrail flags any tool/server-looking token in
a rationale that is not one of these. That makes "the model invented a tool" a
detectable, gate-able condition (the risk-classification analog of the ROI engine's
dollar-figure check).
"""

from __future__ import annotations

# Benign, everyday tools that carry no inherent risk signal.
BENIGN_TOOLS: tuple[str, ...] = (
    "search",
    "summarize",
    "translate",
    "calculate",
    "format_json",
    "plan",
    "classify_text",
    "rank_results",
    "generate_report",
)

# Reads/collects of potentially sensitive data.
READ_SENSITIVE_TOOLS: tuple[str, ...] = (
    "read_file",
    "db_query",
    "read_email",
    "list_customers",
    "export_table",
    "read_secret_store",
    "fetch_document",
    "query_crm",
)

# External-send / exfiltration-shaped tools.
EXFIL_TOOLS: tuple[str, ...] = (
    "http_post",
    "send_email",
    "upload_s3",
    "webhook_post",
    "slack_post",
    "ftp_upload",
    "dns_lookup",
)

# Privilege acquisition / use.
PRIVILEGE_TOOLS: tuple[str, ...] = (
    "grant_role",
    "assume_role",
    "create_api_key",
    "escalate_privilege",
    "sudo_exec",
    "modify_iam_policy",
)

# Generic MCP interaction tools (the server itself is named separately).
MCP_TOOLS: tuple[str, ...] = (
    "mcp_fetch",
    "mcp_read_resource",
    "mcp_call_tool",
)

TRUSTED_MCP: tuple[str, ...] = (
    "internal_docs",
    "company_kb",
    "files_mcp",
    "ci_mcp",
)

UNTRUSTED_MCP: tuple[str, ...] = (
    "untrusted_web",
    "public_scraper",
    "third_party_email",
    "external_feed",
)

ALL_TOOLS: tuple[str, ...] = (
    BENIGN_TOOLS + READ_SENSITIVE_TOOLS + EXFIL_TOOLS + PRIVILEGE_TOOLS + MCP_TOOLS
)
ALL_MCP: tuple[str, ...] = TRUSTED_MCP + UNTRUSTED_MCP

# Everything a rationale is allowed to name.
VOCAB: frozenset[str] = frozenset(ALL_TOOLS + ALL_MCP)

_KIND_BY_TOOL: dict[str, str] = {
    **{t: "benign" for t in BENIGN_TOOLS},
    **{t: "read_sensitive" for t in READ_SENSITIVE_TOOLS},
    **{t: "exfil" for t in EXFIL_TOOLS},
    **{t: "privilege" for t in PRIVILEGE_TOOLS},
    **{t: "mcp" for t in MCP_TOOLS},
}


def tool_kind(name: str) -> str:
    """Return the coarse risk-kind of a tool name (``unknown`` if not in vocab)."""
    return _KIND_BY_TOOL.get(name, "unknown")


def is_untrusted_mcp(server: str) -> bool:
    return server in UNTRUSTED_MCP
