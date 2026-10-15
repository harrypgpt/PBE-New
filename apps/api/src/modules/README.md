# Backend modules

One folder per module, as defined in `docs/architecture/MODULE_BOUNDARIES.md`
(e.g. `identity/`, `tenancy/`, `insights/risk-fingerprint/`).

Empty in Stage 1. The allowed dependencies between modules are recorded in
`tooling/module-boundaries.json` and enforced by the `pbe/module-boundaries` lint rule:
a module may import only from modules in a lower tier, or from listed same-tier modules.
