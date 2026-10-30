# @tollgate/bench

Red-team benchmark: 16 attack scenarios, 5 benign controls, 3 targets.

**Trust zone:** Offline by default

**Status:** not implemented yet. Scaffolded on 30 Oct 2026; product code starts 1 Nov 2026 (see `HACKATHON.md`, Q-001).

## Responsibility

- Targets: a naive agent, the stock `mppx` policy and Tollgate.
- Prints a results table and writes JSON and HTML reports. Measured and published, never assumed.
- Runs from fixtures with no network and no funds, so a judge gets from a fresh clone to a result in under five minutes.
