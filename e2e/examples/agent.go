// A complete agent in plain Go (standard library only): it buys one thing through Tollgate, with no SDK.
//
// Run (the sandbox must be running; in another terminal, from the repo root: `pnpm sandbox`):
//
//	go run e2e/examples/agent.go [honest|swaps-payee|bad-rate|...]
//
// This is the whole 402 loop the TypeScript SDK does for you:
//  1. ask the merchant           -> it answers 402 with a payment request (the "challenge")
//  2. POST /v1/authorize         -> the gateway runs its twelve checks: ALLOW, DENY or NEEDS_APPROVAL
//  3. POST /v1/payments/:id/sign -> only after ALLOW: the signer signs exactly what was approved
//  4. broadcast the signed bytes -> eth_sendRawTransaction on the chain
//  5. ask the merchant again     -> with proof of payment
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"os"
	"strings"
	"time"
)

type obj = map[string]any

var box struct {
	Gateway, World, AgentToken, MandateID, Payer string
}

func die(f string, a ...any) { fmt.Fprintf(os.Stderr, f+"\n", a...); os.Exit(1) }

func do(method, url, token string, body any, headers map[string]string) (int, obj) {
	var r io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		r = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, url, r)
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	res, err := (&http.Client{Timeout: 20 * time.Second}).Do(req)
	if err != nil {
		die("Cannot reach %s: %v", url, err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	out := obj{}
	_ = json.Unmarshal(raw, &out)
	return res.StatusCode, out
}

func gateway(method, path string, body any) (int, obj) {
	return do(method, box.Gateway+path, box.AgentToken, body, nil)
}

func rpc(method string, params ...any) any {
	_, j := do("POST", box.World+"/rpc", "", obj{"jsonrpc": "2.0", "id": 1, "method": method, "params": params}, nil)
	if j["error"] != nil {
		die("%s failed: %v", method, j["error"])
	}
	return j["result"]
}

func hexInt(v any) *big.Int {
	n := new(big.Int)
	n.SetString(strings.TrimPrefix(fmt.Sprint(v), "0x"), 16)
	return n
}

func main() {
	raw, err := os.ReadFile(".sandbox.json")
	if err != nil {
		die("The sandbox is not running. In another terminal, from the repo root, run:  pnpm sandbox\nWait for \"The sandbox is running\", then run this again from the repo root.")
	}
	var sb obj
	_ = json.Unmarshal(raw, &sb)
	box.Gateway, box.World, box.AgentToken = fmt.Sprint(sb["gateway"]), fmt.Sprint(sb["world"]), fmt.Sprint(sb["agentToken"])
	box.MandateID, box.Payer = fmt.Sprint(sb["mandateId"]), fmt.Sprint(sb["payer"])

	behaviour := "honest"
	if len(os.Args) > 1 {
		behaviour = os.Args[1]
	}
	// Make the simulated merchant act this way. (In real life you do not get to choose; that is the point.)
	do("POST", box.World+"/_control/merchant", "", obj{"host": "merchant.example.com", "payee": "merchant.near", "price": "0.30", "behavior": behaviour}, nil)

	// merchant.example.com does not exist on the internet, so we send its traffic to the simulated world with a Host hint.
	url := box.World + "/data"
	vhost := map[string]string{"x-virtual-host": "merchant.example.com", "x-payer": box.Payer}
	fmt.Printf("The merchant is acting: %s. The agent asks for https://merchant.example.com/data ...\n\n", behaviour)

	// 1. Ask. A merchant that wants money answers 402 and describes the payment.
	status, body := do("GET", url, "", nil, vhost)
	if status != 402 {
		die("The merchant answered %d, not 402: %v", status, body)
	}
	challenge := any(body)
	if c, ok := body["challenge"]; ok {
		challenge = c
	}

	// 2. Ask Tollgate. This is the only place the decision is made; the agent never decides.
	_, d := gateway("POST", "/v1/authorize", obj{"mandateId": box.MandateID, "host": "merchant.example.com",
		"purpose": "buy the market brief", "challenge": challenge, "payer": box.Payer})
	switch d["decision"] {
	case "DENY":
		fmt.Printf("BLOCKED by %v. Nothing was paid.\n", d["failedCheck"])
		checks, _ := d["checks"].([]any)
		for _, c := range checks {
			m := c.(obj)
			if m["result"] != "pass" {
				ev, _ := json.Marshal(m["evidence"])
				fmt.Printf("  %v %v: %v  %s\n", m["id"], m["name"], m["result"], ev)
			}
		}
		return
	case "NEEDS_APPROVAL":
		die("HELD for the owner. Approve or reject it on the dashboard, under Approvals, then ask again.")
	case "ALLOW":
	default:
		die("The gateway said something unexpected: %v", d)
	}

	// 3. Sign. We supply the fees and nonce; the signer builds the transfer from the approved decision, so we cannot change who is paid.
	bind := d["bind"].(obj)
	tip := hexInt(rpc("eth_maxPriorityFeePerGas"))
	blk, _ := rpc("eth_getBlockByNumber", "latest", false).(obj)
	base := new(big.Int)
	if f, ok := blk["baseFeePerGas"]; ok {
		base = hexInt(f)
	}
	maxFee := new(big.Int).Add(new(big.Int).Mul(base, big.NewInt(2)), tip)
	tx := obj{"nonce": hexInt(rpc("eth_getTransactionCount", box.Payer, "pending")).Int64(), "gas": "100000",
		"maxPriorityFeePerGas": tip.String(), "maxFeePerGas": maxFee.String()}
	s, signed := gateway("POST", fmt.Sprintf("/v1/payments/%v/sign", d["decisionId"]), obj{"tx": tx})
	if s != 200 {
		die("The payment could not be signed (%d): %v", s, signed["error"])
	}

	// 4. Broadcast the signed bytes ourselves. Tollgate never sends money; it only signs what it approved.
	txHash := rpc("eth_sendRawTransaction", signed["signedTx"])

	// 5. Ask again with proof of payment.
	proof, _ := json.Marshal(obj{"challengeId": challenge.(obj)["id"], "txHash": txHash, "depositAddress": bind["to"]})
	vhost["x-payment-proof"] = string(proof)
	status, body = do("GET", url, "", nil, vhost)
	out, _ := json.Marshal(body)
	fmt.Printf("PAID.  The merchant answered %d: %s\n", status, out)

	// Optional: ask the gateway to check 1Click and settle the held money.
	gateway("POST", fmt.Sprintf("/v1/payments/%v/reconcile", d["decisionId"]), nil)
	fmt.Printf("\nOpen the dashboard (%s/dashboard) and click a row to see the twelve checks.\n", box.Gateway)
}
