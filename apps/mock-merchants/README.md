# @tollgate/mock-merchants

Fake sellers, a fake directory and a fake 1Click, for the benchmark and offline runs.

**Trust zone:** Test only

**Status:** not implemented yet. Scaffolded on 30 Oct 2026; product code starts 1 Nov 2026 (see `HACKATHON.md`, Q-001).

## Responsibility

- Issues legitimate and malicious challenges covering attacks A01-A16, plus a negotiating seller agent that makes counter-offers.
- Record-and-replay fixtures for 1Click, merchant and chain responses, scrubbed of secrets and replayed byte-identically, so the benchmark runs with no network and no funds.
