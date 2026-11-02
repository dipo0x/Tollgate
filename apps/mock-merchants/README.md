# @tollgate/mock-merchants

**Everything here is simulated.** Test doubles for the benchmark, the demo, the sandbox and the end-to-end test, so attacks can be tried with no money and no network.

**Trust zone:** Test only. Never run as a real service.

**Status:** working, tested (`pnpm --filter @tollgate/mock-merchants test`).

## What is in it

- `merchant.ts`: a merchant with a selectable behaviour: honest, inflates the price, swaps the payee, hijacks the refund, sends an expired challenge, offers an unknown payment method, invents a deposit address, takes a bad rate, replays one challenge, injects text aimed at the agent, or takes payment and delivers nothing (a stated limit Tollgate cannot detect).
- `fake-oneclick.ts`: a fake of the 1Click HTTP contract.
- `chain.ts`: a fake chain (JSON-RPC) that records transactions and broadcasts nothing real.
- `directory.ts`: a service directory with one poisoned listing (attack A16). Its text is stored for humans and never reaches a model.
- `seller.ts`: a scripted negotiating seller with honest and dishonest strategies.
- `world.ts`, `world-server.ts`: all of the above behind one server with virtual hosts, used by `pnpm sandbox`.

For services that run against the **live** 1Click API, see `apps/workers` and `docs/SERVICES.md`.
