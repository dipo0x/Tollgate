#!/usr/bin/env bash
# Walks one agent through the gateway: rules, a payment held for approval, approval, three attacks, the
# kill switch, and the audit check. Offline: it replays recorded 1Click responses, so it needs no key,
# no network and no funds. Start the gateway first:  pnpm --filter @tollgate/gateway start
#
# Run it ONCE per gateway process. The recorded deposit addresses are single-use, and the gateway refuses to
# let one be used twice (check C10). A second run is stopped at step 3 for exactly that reason: restart the
# gateway to run the walkthrough again.
set -euo pipefail
cd "$(dirname "$0")/../../.."
set -a; [ -f .env ] && . ./.env; set +a
: "${GATEWAY_OPERATOR_TOKEN:?set GATEWAY_OPERATOR_TOKEN in .env (see .env.example)}"
B="${GATEWAY_URL:-http://127.0.0.1:8787}"; OP="Authorization: Bearer $GATEWAY_OPERATOR_TOKEN"; J="Content-Type: application/json"
PAYER=0xaf88d065e77c8cc2239327c5edb3a432268e5831
FROM=$(date -u -v-1d +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '-1 day' +%Y-%m-%dT%H:%M:%SZ)
TO=$(date -u -v+7d +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '+7 days' +%Y-%m-%dT%H:%M:%SZ)
EXP=$(date -u -v+5M +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '+5 minutes' +%Y-%m-%dT%H:%M:%SZ)
RUN="$(date +%s)$RANDOM"   # unique mandate, service and challenge ids on every run
say() { printf '\n\033[1m%s\033[0m\n' "$1"; }
py() { python3 -c "import sys,json; d=json.load(sys.stdin); print($1)"; }
show() { python3 -c "import sys,json; d=json.load(sys.stdin); print('  decision:', d['decision'], '| failed check:', d.get('failedCheck','-'), '|', ' '.join(c['id']+':'+c['result'][0] for c in d['checks']))"; }

curl -sf "$B/healthz" >/dev/null || { echo "gateway not reachable at $B: run 'pnpm --filter @tollgate/gateway start' first"; exit 1; }

say "1. Register a service and enable it (a service must be probed before it can be paid)"
curl -s -X POST "$B/v1/services" -H "$OP" -H "$J" -d "{\"id\":\"svc_$RUN\",\"name\":\"Market data (demo)\",\"category\":\"data\",\"host\":\"merchant.example.com\",\"providerUrl\":\"https://merchant.example.com\",\"pricing\":{\"model\":\"per_request\",\"quoted\":\"0.25\",\"currency\":\"USDC\"},\"paymentRails\":[],\"limits\":{\"maxPerRequest\":\"1.00\",\"timeoutMs\":8000}}" | py "'  starts as:', d['verification'], '| enabled =', d['enabled']" || true
curl -s -X POST "$B/v1/services/svc_$RUN/probe-result" -H "$OP" -H "$J" -d '{"verification":"endpoint-checked","payee":"merchant.near","health":"healthy"}' >/dev/null
curl -s -X POST "$B/v1/services/svc_$RUN/enable" -H "$OP" | py "'  after probe + enable: enabled =', d['enabled']"

say "2. The owner writes a mandate (the rules). The agent token is shown once."
M="mnd_$RUN"
AG=$(curl -s -X POST "$B/v1/mandates" -H "$OP" -H "$J" -d "{\"id\":\"$M\",\"version\":1,\"principal\":\"owner\",\"agentId\":\"research-agent\",\"validFrom\":\"$FROM\",\"validUntil\":\"$TO\",\"budget\":{\"currency\":\"USDC\",\"total\":\"5.00\",\"perPayment\":\"1.00\"},\"allowedHosts\":[\"merchant.example.com\"],\"allowedOriginNetworks\":[\"eip155:42161\"],\"allowedAssets\":[\"USDC\"],\"payee\":{\"mode\":\"pin-on-first-approval\"},\"price\":{\"tolerancePct\":3,\"onExceed\":\"needs_approval\"},\"approval\":{\"above\":\"1.00\",\"riskAbove\":90,\"firstPayeeRequiresApproval\":true},\"refund\":{\"mustBePayerOrPinned\":true}}" | python3 -c "import sys,json; print(json.load(sys.stdin)['agentToken'])")
AGH="Authorization: Bearer $AG"; echo "  mandate $M: up to 5.00 USDC, max 1.00 per payment (agent token issued)"

auth() { curl -s -X POST "$B/v1/authorize" -H "$AGH" -H "$J" -d "{\"mandateId\":\"$M\",\"host\":\"merchant.example.com\",\"purpose\":\"buy a dataset\",\"payer\":\"$PAYER\",\"challenge\":{\"id\":\"$1-$RUN\",\"method\":\"nearintents\",\"recipient\":\"$2\",\"amount\":\"0.251000\",\"currency\":\"USDC\",\"originNetwork\":\"eip155:42161\",\"refundTo\":\"$PAYER\",\"expires\":\"$EXP\"}}"; }

say "3. The agent asks to pay an honest merchant (first time paying this payee, so a human decides)"
R=$(auth honest 0xdep0000000000000000000000000000000000001); echo "$R" | show
if ! echo "$R" | grep -q '"NEEDS_APPROVAL"'; then
  echo "  Stopped here on purpose: this gateway has already seen the demo's deposit address, and a deposit address"
  echo "  can only be used once (check C10). Restart the gateway to run the walkthrough again."; exit 0
fi
ID=$(echo "$R" | python3 -c "import sys,json; print(json.load(sys.stdin)['decisionId'])")

say "4. The owner approves it. The payee is now pinned and the money is held."
curl -s -X POST "$B/v1/approvals/$ID/approve" -H "$OP" -H "$J" -d '{"reason":"known data supplier"}' | py "'  decision:', d['decision'], '| signer will be asked to pay', d['bind']['amount'], d['bind']['asset'], 'to', d['bind']['to']"
curl -s "$B/v1/mandates/$M" -H "$OP" | py "'  budget:', {k: d['balance'][k] for k in ('committed','remaining')}"

say "5. ATTACK: the merchant swaps the payee to an attacker"
auth swap 0xdep0000000000000000000000000000000000002 | show
say "6. ATTACK: a deposit address 1Click has never heard of"
auth fake 0x0000000000000000000000000000000000000001 | show
say "7. ATTACK: replaying a deposit address that was already paid"
auth replay 0xdep0000000000000000000000000000000000003 | show

say "8. The kill switch"
curl -s -X POST "$B/v1/freeze" -H "$OP" >/dev/null
auth frozen 0xdep0000000000000000000000000000000000001 | python3 -c "import sys,json; d=json.load(sys.stdin); print('  while frozen:', d['decision'], '| reason:', d.get('reason'))"
curl -s -X POST "$B/v1/unfreeze" -H "$OP" >/dev/null; echo "  unfrozen"

say "9. Every step above is in a tamper-evident log"
curl -s "$B/v1/audit/verify" -H "$OP" | py "'  chain intact:', d['ok'], '| entries:', d['length']"
echo "  check it yourself, without trusting the gateway:  pnpm --filter @tollgate/core verify-log \$PWD/apps/gateway/.data/audit.jsonl"
