#!/usr/bin/env python3
"""A complete agent in plain Python (standard library only): it buys one thing through Tollgate, with no SDK.

Run (the sandbox must be running; in another terminal, from the repo root: `pnpm sandbox`):
    python3 e2e/examples/agent.py [honest|swaps-payee|bad-rate|...]

This is the whole 402 loop the TypeScript SDK does for you:
    1. ask the merchant           -> it answers 402 with a payment request (the "challenge")
    2. POST /v1/authorize         -> the gateway runs its twelve checks and answers ALLOW, DENY or NEEDS_APPROVAL
    3. POST /v1/payments/:id/sign -> only after ALLOW: the signer signs exactly what was approved
    4. broadcast the signed bytes -> eth_sendRawTransaction on the chain
    5. ask the merchant again     -> with proof of payment
"""
import json, os, sys, urllib.request, urllib.error

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")
try:
    box = json.load(open(os.path.join(ROOT, ".sandbox.json")))
except OSError:
    sys.exit('The sandbox is not running. In another terminal, from the repo root, run:  pnpm sandbox\nWait for "The sandbox is running", then run this again.')

behaviour = sys.argv[1] if len(sys.argv) > 1 else "honest"


def http(method, url, token=None, body=None, headers=None):
    h = {"Content-Type": "application/json", **(headers or {})}
    if token:
        h["Authorization"] = "Bearer " + token
    req = urllib.request.Request(url, data=json.dumps(body).encode() if body is not None else None, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw or b"null")
        except ValueError:
            return e.code, {"raw": raw.decode(errors="replace")}


def gateway(method, path, body=None):
    return http(method, box["gateway"] + path, box["agentToken"], body)


def rpc(method, params):
    _, j = http("POST", box["world"] + "/rpc", body={"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
    if "error" in j:
        raise RuntimeError("%s failed: %s" % (method, j["error"]))
    return j["result"]


# Make the simulated merchant act this way. (In real life you do not get to choose; that is the point.)
http("POST", box["world"] + "/_control/merchant", body={"host": "merchant.example.com", "payee": "merchant.near", "price": "0.30", "behavior": behaviour})

# merchant.example.com does not exist on the internet, so we send its traffic to the simulated world with a Host hint.
URL = box["world"] + "/data"
VHOST = {"x-virtual-host": "merchant.example.com", "x-payer": box["payer"]}
print("The merchant is acting: %s. The agent asks for https://merchant.example.com/data ...\n" % behaviour)

# 1. Ask. A merchant that wants money answers 402 and describes the payment.
status, challenge = http("GET", URL, headers=VHOST)
if status != 402:
    sys.exit("The merchant answered %s, not 402: %s" % (status, challenge))
challenge = challenge.get("challenge", challenge)

# 2. Ask Tollgate. This is the only place the decision is made; the agent never decides.
_, d = gateway("POST", "/v1/authorize", {"mandateId": box["mandateId"], "host": "merchant.example.com",
                                          "purpose": "buy the market brief", "challenge": challenge, "payer": box["payer"]})
if d.get("decision") == "DENY":
    print("BLOCKED by %s. Nothing was paid." % d.get("failedCheck"))
    for c in d.get("checks", []):
        if c["result"] != "pass":
            print("  %s %s: %s  %s" % (c["id"], c["name"], c["result"], json.dumps(c.get("evidence"))))
    sys.exit(0)
if d.get("decision") == "NEEDS_APPROVAL":
    sys.exit("HELD for the owner. Approve or reject it on the dashboard, under Approvals, then ask again.")
if d.get("decision") != "ALLOW":
    sys.exit("The gateway said something unexpected: %s" % d)

# 3. Sign. We supply the fees and nonce; the signer builds the transfer from the approved decision, so we cannot change who is paid.
chain = d["bind"]["chain"]
tip = int(rpc("eth_maxPriorityFeePerGas", []), 16)
base = int(rpc("eth_getBlockByNumber", ["latest", False]).get("baseFeePerGas") or "0x0", 16)
tx = {"nonce": int(rpc("eth_getTransactionCount", [box["payer"], "pending"]), 16), "gas": "100000",
      "maxPriorityFeePerGas": str(tip), "maxFeePerGas": str(base * 2 + tip)}
s, signed = gateway("POST", "/v1/payments/%s/sign" % d["decisionId"], {"tx": tx})
if s != 200:
    sys.exit("The payment could not be signed (%s): %s" % (s, signed.get("error")))

# 4. Broadcast the signed bytes ourselves. Tollgate never sends money; it only signs what it approved.
tx_hash = rpc("eth_sendRawTransaction", [signed["signedTx"]])

# 5. Ask again with proof of payment.
status, body = http("GET", URL, headers={**VHOST, "x-payment-proof": json.dumps(
    {"challengeId": challenge["id"], "txHash": tx_hash, "depositAddress": d["bind"]["to"]})})
print("PAID.  The merchant answered %s: %s" % (status, json.dumps(body)))

# Optional: ask the gateway to check 1Click and settle the held money.
gateway("POST", "/v1/payments/%s/reconcile" % d["decisionId"])
print("\nOpen the dashboard (%s/dashboard) and click a row to see the twelve checks." % box["gateway"])
