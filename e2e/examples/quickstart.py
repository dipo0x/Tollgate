#!/usr/bin/env python3
"""Tollgate quickstart in Python (standard library only, Python 3.8+).

Run from anywhere:   python3 e2e/examples/quickstart.py
It needs a running gateway (`pnpm dev`). It registers a service, writes a mandate, and asks for one
payment decision. Nothing is paid: it only shows what the gateway would decide.
"""
import json, os, sys, time, urllib.request, urllib.error
from datetime import datetime, timedelta, timezone

GATEWAY = os.environ.get("GATEWAY_URL", "http://127.0.0.1:8787")


def operator_token():
    """The owner's token: from the environment, else from the .env file at the repo root."""
    if os.environ.get("GATEWAY_OPERATOR_TOKEN"):
        return os.environ["GATEWAY_OPERATOR_TOKEN"]
    env = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", ".env")
    try:
        for line in open(env):
            if line.startswith("GATEWAY_OPERATOR_TOKEN="):
                return line.split("=", 1)[1].strip()
    except OSError:
        pass
    sys.exit("No GATEWAY_OPERATOR_TOKEN. Run `pnpm onboard` in the repo root first.")


def call(method, path, token, body=None):
    """One request to the gateway. Returns (status, parsed JSON). Never raises on an HTTP error status."""
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(GATEWAY + path, data=data, method=method,
                                 headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"null")
    except urllib.error.URLError:
        sys.exit("Cannot reach the gateway at %s. Is `pnpm dev` running?" % GATEWAY)


def must(status, body, step):
    if status >= 300:
        sys.exit("%s failed (%s): %s" % (step, status, (body or {}).get("error", body)))
    return body


def iso(dt):
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


op = operator_token()
run = str(int(time.time()))                      # makes every id unique, so you can run this again and again
host = "api-%s.example.com" % run
now = datetime.now(timezone.utc)

# 1-3. A service is a website the agent may pay. Register it, record the probe result, switch it on.
must(*call("POST", "/v1/services", op, {
    "id": "svc_" + run, "name": "Market data", "category": "data", "host": host, "providerUrl": "https://" + host,
    "pricing": {"model": "per_request", "quoted": "0.30", "currency": "USDC"}, "paymentRails": [],
    "limits": {"maxPerRequest": "1.00", "timeoutMs": 8000}}), "register service")
must(*call("POST", "/v1/services/svc_%s/probe-result" % run, op,
           {"verification": "endpoint-checked", "payee": "merchant.near", "health": "healthy"}), "probe")
must(*call("POST", "/v1/services/svc_%s/enable" % run, op), "enable")

# 4. The mandate: this agent may spend 20 USDC in all, 1 per payment, only at that host.
mandate = {
    "id": "mnd_" + run, "version": 1, "principal": "you@example.com", "agentId": "research-agent",
    "validFrom": iso(now), "validUntil": iso(now + timedelta(days=7)),
    "budget": {"currency": "USDC", "total": "20.00", "perPayment": "1.00"},
    "allowedHosts": [host], "allowedOriginNetworks": ["eip155:42161"], "allowedAssets": ["USDC"],
    "payee": {"mode": "registry"},
    "price": {"tolerancePct": 3, "onExceed": "needs_approval"},
    "approval": {"above": "1.00", "riskAbove": 90, "firstPayeeRequiresApproval": True},
    "refund": {"mustBePayerOrPinned": True},
}
created = must(*call("POST", "/v1/mandates", op, mandate), "create mandate")
agent_token = created["agentToken"]              # shown ONCE. Put it in your agent's environment.
print("mandate %s created. agent token: %s  (copy it now, it is never shown again)" % (mandate["id"], agent_token))

# 5. The agent's view of its own mandate (uses the AGENT token, not the owner's).
m = must(*call("GET", "/v1/mandates/" + mandate["id"], agent_token), "read mandate")
print("budget:", json.dumps(m.get("ledger", m.get("balance", {}))) if isinstance(m, dict) else m)

# 6. A merchant answered 402 with this payment request. Ask the gateway whether to pay it.
challenge = {"id": "ch_" + run, "method": "nearintents", "recipient": "deposit-address", "amount": "0.30", "currency": "USDC",
             "originNetwork": "eip155:42161", "refundTo": "0xYourSignerPublicAddress", "expires": iso(now + timedelta(minutes=10))}
status, d = call("POST", "/v1/authorize", agent_token, {"mandateId": mandate["id"], "host": host, "purpose": "buy market data", "challenge": challenge})
print("\nauthorize ->", status, d.get("decision") if isinstance(d, dict) else d)
for c in (d or {}).get("checks", []):
    if c.get("result") != "pass":
        print("  %s %s: %s  %s" % (c["id"], c["name"], c["result"], json.dumps(c.get("evidence"))))
print("\nOnly ALLOW means the agent may pay. DENY and NEEDS_APPROVAL mean it must not.")
