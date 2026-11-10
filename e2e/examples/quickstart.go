// Tollgate quickstart in Go (standard library only, Go 1.20+).
//
// Run from the repo root:   go run e2e/examples/quickstart.go
// It needs a running gateway (`pnpm dev`). It registers a service, writes a mandate, and asks for one
// payment decision. Nothing is paid: it only shows what the gateway would decide.
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

var gateway = env("GATEWAY_URL", "http://127.0.0.1:8787")

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func die(f string, a ...any) { fmt.Fprintf(os.Stderr, f+"\n", a...); os.Exit(1) }

// operatorToken is the owner's token: from the environment, else from the .env file in the current directory.
func operatorToken() string {
	if v := os.Getenv("GATEWAY_OPERATOR_TOKEN"); v != "" {
		return v
	}
	b, _ := os.ReadFile(".env")
	for _, l := range strings.Split(string(b), "\n") {
		if strings.HasPrefix(l, "GATEWAY_OPERATOR_TOKEN=") {
			return strings.TrimSpace(strings.TrimPrefix(l, "GATEWAY_OPERATOR_TOKEN="))
		}
	}
	die("No GATEWAY_OPERATOR_TOKEN. Run `pnpm onboard` in the repo root, then run this from the repo root.")
	return ""
}

type obj = map[string]any

// call makes one request to the gateway and returns the status and parsed JSON. It does not fail on an HTTP error status.
func call(method, path, token string, body any) (int, obj) {
	var r io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		r = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, gateway+path, r)
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	res, err := (&http.Client{Timeout: 15 * time.Second}).Do(req)
	if err != nil {
		die("Cannot reach the gateway at %s. Is `pnpm dev` running?", gateway)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	out := obj{}
	_ = json.Unmarshal(raw, &out)
	return res.StatusCode, out
}

func must(step string, status int, body obj) obj {
	if status >= 300 {
		die("%s failed (%d): %v", step, status, body["error"])
	}
	return body
}

func iso(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05Z") }

func main() {
	op := operatorToken()
	run := fmt.Sprint(time.Now().Unix()) // makes every id unique, so you can run this again and again
	host := "api-" + run + ".example.com"
	now := time.Now()

	// 1-3. A service is a website the agent may pay. Register it, record the probe result, switch it on.
	s, b := call("POST", "/v1/services", op, obj{
		"id": "svc_" + run, "name": "Market data", "category": "data", "host": host, "providerUrl": "https://" + host,
		"pricing":      obj{"model": "per_request", "quoted": "0.30", "currency": "USDC"},
		"paymentRails": []any{}, "limits": obj{"maxPerRequest": "1.00", "timeoutMs": 8000}})
	must("register service", s, b)
	s, b = call("POST", "/v1/services/svc_"+run+"/probe-result", op, obj{"verification": "endpoint-checked", "payee": "merchant.near", "health": "healthy"})
	must("probe", s, b)
	s, b = call("POST", "/v1/services/svc_"+run+"/enable", op, nil)
	must("enable", s, b)

	// 4. The mandate: this agent may spend 20 USDC in all, 1 per payment, only at that host.
	mandateID := "mnd_" + run
	s, b = call("POST", "/v1/mandates", op, obj{
		"id": mandateID, "version": 1, "principal": "you@example.com", "agentId": "research-agent",
		"validFrom": iso(now), "validUntil": iso(now.Add(7 * 24 * time.Hour)),
		"budget":       obj{"currency": "USDC", "total": "20.00", "perPayment": "1.00"},
		"allowedHosts": []string{host}, "allowedOriginNetworks": []string{"near"}, "allowedAssets": []string{"USDC"},
		"payee":    obj{"mode": "registry"},
		"price":    obj{"tolerancePct": 3, "onExceed": "needs_approval"},
		"approval": obj{"above": "1.00", "riskAbove": 90, "firstPayeeRequiresApproval": true},
		"refund":   obj{"mustBePayerOrPinned": true}})
	agentToken, _ := must("create mandate", s, b)["agentToken"].(string) // shown ONCE. Put it in your agent's environment.
	fmt.Printf("mandate %s created. agent token: %s  (copy it now, it is never shown again)\n", mandateID, agentToken)

	// 5. The agent's view of its own mandate (uses the AGENT token, not the owner's).
	s, b = call("GET", "/v1/mandates/"+mandateID, agentToken, nil)
	must("read mandate", s, b)
	led, _ := json.Marshal(firstOf(b, "ledger", "balance"))
	fmt.Println("budget:", string(led))

	// 6. A merchant answered 402 with this payment request. Ask the gateway whether to pay it.
	s, b = call("POST", "/v1/authorize", agentToken, obj{"mandateId": mandateID, "host": host, "purpose": "buy market data",
		"challenge": obj{"id": "ch_" + run, "method": "nearintents", "recipient": "deposit-address", "amount": "0.30", "currency": "USDC",
			"originNetwork": "near", "refundTo": "your-signer-account.near", "expires": iso(now.Add(10 * time.Minute))}})
	fmt.Printf("\nauthorize -> %d %v\n", s, b["decision"])
	if checks, ok := b["checks"].([]any); ok {
		for _, c := range checks {
			m := c.(obj)
			if m["result"] != "pass" {
				ev, _ := json.Marshal(m["evidence"])
				fmt.Printf("  %v %v: %v  %s\n", m["id"], m["name"], m["result"], ev)
			}
		}
	}
	fmt.Println("\nOnly ALLOW means the agent may pay. DENY and NEEDS_APPROVAL mean it must not.")
}

func firstOf(m obj, keys ...string) any {
	for _, k := range keys {
		if v, ok := m[k]; ok {
			return v
		}
	}
	return obj{}
}
