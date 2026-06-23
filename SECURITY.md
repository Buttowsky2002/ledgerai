# Security Policy

This is the security policy for **LedgerAI** (formerly AgentLedger AI). LedgerAI is
an AI cost, risk, and ROI control plane that handles tenant spend data, virtual
keys, and connector credentials, so we take security seriously and welcome reports
from the security community.

## Supported Versions

LedgerAI is pre-1.0 and ships from `main`; there are no long-term-support branches
yet. Security fixes land on `main` and are released from there.

| Version | Supported |
|---------|-----------|
| `main` (latest) | ✅ |
| older commits / forks | ❌ (please reproduce on `main`) |

## Reporting a Vulnerability

**Please do not open a public GitHub issue, pull request, or discussion for a
security vulnerability** — public disclosure before a fix puts users at risk.

Report privately through either channel:

- **GitHub Security Advisories** (preferred): the repository's **Security** tab →
  *Report a vulnerability*. This keeps the report private and tracked.
- **Email:** `security@ledgerai.dev`

> **`SECURITY_CONTACT_REQUIRED`** — anyone forking or deploying LedgerAI MUST
> replace `security@ledgerai.dev` above with a monitored security mailbox (and/or
> enable private Security Advisories) before running in production. A placeholder
> contact is not a working disclosure channel.

Please include:

- A clear description of the vulnerability and its **impact**.
- **Steps to reproduce**, or a minimal proof of concept.
- The affected component and version/commit (e.g. `services/gateway` @ `<sha>`).
- Any suggested mitigation.

### What NOT to include in a report

To keep the report safe to receive and handle:

- **No real secrets, tokens, API keys, or virtual keys** — redact them. (LedgerAI's
  own rule is that no secret ever lands in a committed file; please don't send live
  ones either.)
- **No real customer/tenant data or PII** — use synthetic data in any PoC.
- **No bulk data dumps** — attach only the minimum needed to reproduce.
- No exploit payloads that exfiltrate or destroy third-party data.

## Response SLA

| Stage | Target |
|-------|--------|
| Acknowledge receipt | within **2 business days** |
| Triage + severity assessment | within **5 business days** |
| Status updates | at least every **7 days** until resolved |
| Fix or mitigation (high / critical) | targeted within **30 days** |

We practice **coordinated disclosure**: please give us up to **90 days** to
remediate before any public disclosure. We're happy to credit reporters who wish to
be named once a fix ships, and to coordinate a disclosure timeline for complex
issues.

## Safe Harbor

We consider security research conducted in good faith under this policy to be
**authorized**, and we will not pursue or support legal action against you, provided
that you:

- make a genuine effort to follow this policy and act in good faith;
- only access or interact with accounts and data you own or are explicitly
  permitted to test;
- avoid privacy violations, data destruction, and degradation of the service for
  others — **no denial-of-service, spam, social engineering, or physical attacks**;
- stop and report once you have demonstrated a vulnerability, without exploiting it
  further or pivoting to other systems; and
- give us reasonable time to remediate before disclosing.

If you are unsure whether a specific test is acceptable, ask first via the contact
above. This safe harbor covers only LedgerAI itself — it does not authorize testing
of third-party services LedgerAI integrates with (cloud providers, model providers,
connectors); review their policies separately.
