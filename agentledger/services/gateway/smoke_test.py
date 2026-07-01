#!/usr/bin/env python3
"""Smoke test: run the real gateway binary against a mock provider and
verify the full inline path: auth -> DLP redact -> proxy -> usage capture
-> cost accounting -> budget burn -> canonical event emission."""
import http.server, json, os, subprocess, threading, time, urllib.request, sys

# ---- mock OpenAI-compatible upstream on :9911 ----
class Mock(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get('Content-Length', 0))
        body = json.loads(self.rfile.read(n))
        echo = body["messages"][0]["content"]
        resp = json.dumps({
            "id": "cc1", "model": "gpt-4o-2024-11-20",
            "choices": [{"message": {"role": "assistant", "content": echo}}],
            "usage": {"prompt_tokens": 1000, "completion_tokens": 500,
                      "prompt_tokens_details": {"cached_tokens": 200}},
        }).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(resp)))
        self.end_headers()
        self.wfile.write(resp)
    def log_message(self, *a): pass

srv = http.server.HTTPServer(('127.0.0.1', 9911), Mock)
threading.Thread(target=srv.serve_forever, daemon=True).start()

# ---- gateway config + launch ----
cfg = {
    "listen_addr": ":8099",
    "price_book_path": "/home/claude/agentledger/pricing/pricebook.json",
    "providers": [{"name": "openai", "base_url": "http://127.0.0.1:9911",
                   "api_key_env": "OPENAI_API_KEY", "model_prefixes": ["gpt-"]}],
    "virtual_keys": [{"key": "alk_smoke", "tenant_id": "t1", "team_id": "eng",
                      "user_id": "dev@x.com", "app_id": "demo", "environment": "dev",
                      "monthly_budget_usd": 50, "dlp_policy_id": "default-redact"}],
    "dlp": {"fail_mode": "open", "policies": [
        {"id": "default-redact", "action": "redact", "classes": ["credentials", "pci"]}]},
    "events": {"type": "file", "path": "/tmp/events.ndjson", "flush_ms": 100},
}
open("/tmp/gwcfg.json", "w").write(json.dumps(cfg))
if os.path.exists("/tmp/events.ndjson"):
    os.remove("/tmp/events.ndjson")

env = dict(os.environ, BADGERIQ_CONFIG="/tmp/gwcfg.json", OPENAI_API_KEY="sk-mock")
gw = subprocess.Popen(["/tmp/gateway"], env=env,
                      stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    time.sleep(0.6)
    # health
    h = urllib.request.urlopen("http://localhost:8099/healthz", timeout=3).read()
    print("health:", h.decode())

    # chat request containing a real AWS-format key and a Luhn-valid PAN
    req = urllib.request.Request(
        "http://localhost:8099/v1/chat/completions",
        data=json.dumps({"model": "gpt-4o", "messages": [{"role": "user",
            "content": "debug key AKIAIOSFODNN7EXAMPLE and card 4111 1111 1111 1111"}]}).encode(),
        headers={"Authorization": "Bearer alk_smoke", "Content-Type": "application/json"})
    resp = json.loads(urllib.request.urlopen(req, timeout=5).read())
    echoed = resp["choices"][0]["message"]["content"]
    print("upstream saw:", echoed)
    assert "AKIA" not in echoed and "4111" not in echoed, "RAW SECRETS LEAKED UPSTREAM"
    assert "[REDACTED:AWS_ACCESS_KEY]" in echoed and "[REDACTED:CREDIT_CARD]" in echoed

    # budget burn
    usage = json.loads(urllib.request.urlopen("http://localhost:8099/v1/usage", timeout=3).read())
    print("budget snapshot:", json.dumps(usage))
    assert usage["spend_usd_by_key"]["alk_smoke"] > 0

    # canonical event
    time.sleep(0.4)
    ev = json.loads(open("/tmp/events.ndjson").read().splitlines()[0])
    keep = {k: ev[k] for k in ("tenant_id", "team_id", "provider", "response_model",
                               "input_tokens", "cache_read_tokens", "cost_usd",
                               "dlp_action", "risk_severity", "status")}
    print("canonical event:", json.dumps(keep, indent=2))
    assert ev["status"] == "ok" and ev["dlp_action"] == "redact"
    assert ev["cost_usd"] > 0 and ev["cache_read_tokens"] == 200
    print("\nSMOKE TEST PASSED")
finally:
    gw.terminate()
    srv.shutdown()
