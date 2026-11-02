# @tollgate/registry

The list of services an agent may pay, with a verification level, a quoted price, payment rails and a payee.

**Trust zone:** Trusted data, untrusted text

**Status:** built, tested (9 tests). The gateway stores the rows in Postgres and loads them into this registry at boot.

## The rules it enforces

- A new service always starts `unverified` and **disabled**, whatever the caller says. Nothing is payable until it has been probed and a human has enabled it.
- Enabling a service that is `unverified` or `disabled` is refused.
- The payee comes from the service's own payment request when probed, never from a listing. If it later changes, the service is disabled until a human re-enables it.
- `toPlannerView` returns structured fields only. **Listing text copied from a third-party directory is stored for a human to read and is never placed in a model prompt.** This is the defence for attack A16. No LLM planner exists yet; the rule is built into the only view one would be given.
- Feeds check C02 (host in scope) and C05 (payee binding) through `lookup`.
