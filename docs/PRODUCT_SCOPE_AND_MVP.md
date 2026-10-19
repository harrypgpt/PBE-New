# Product Scope and MVP

Status: Draft for product-owner review, MA-00, 2026-10-16. The MVP boundary (OD-13) was **approved** on 2026-10-18 as recommended in §4 (ADR-030).

## 1. Product statement
PBE is commercial decision-intelligence software for **pre-pivotal** bioequivalence risk assessment. It helps pharmaceutical development teams understand what their evidence suggests, what drives risk, what is missing, how uncertainty affects conclusions, and which experiments or formulation changes are worth evaluating.

**PBE is decision support.** It never guarantees BE success, never claims to replace a required regulatory BE study, and every result states that outputs can be wrong and require scientific and human judgement.

## 2. Supported scientific scope (ADR-011)

| Supported | Unsupported (shown as "Unsupported scope", runs blocked) |
|---|---|
| Immediate-release (IR) oral solid dosage forms, such as tablets and capsules, as defined by the controlled vocabulary approved in Stage 8 | Modified-release (extended, delayed, pulsatile) · orally disintegrating or other special oral forms unless the reviewer explicitly includes them · oral solutions and suspensions · parenteral · inhalation · topical and transdermal · nasal · ophthalmic · rectal and vaginal · biologics · locally acting products · combination or complex products unless separately validated |

Whether a borderline form (e.g. chewable, orodispersible, fixed-dose combination) is in scope is decided by the scientific reviewer (OD-10) when the controlled vocabulary is approved. Until then the Stage 8 draft vocabulary treats them as unsupported, with the reason shown (ADR-030, D8-2).

## 3. Capability scope

| Area | MVP | Post-MVP |
|---|---|---|
| Accounts, tenants, roles, audit | ✔ | Audit search UI, SSO |
| Dashboard, projects, scenarios | ✔ | — |
| Manual evidence entry with provenance and units | ✔ | — |
| CSV / Excel ingestion with review | ✔ | — |
| PDF / Word ingestion with review | — | ✔ (Stage 11) |
| Readiness (checklist; percentage only after OD-23 approval) | ✔ | — |
| Reviewed deterministic methods (S2) | ✔ (those approved by the reviewer) | more methods |
| Reviewed statistical methods incl. sample size (S3) | ✔ (those approved) | more designs |
| Immutable runs, reports, scenario comparison | ✔ | — |
| C5 Digital twin (versioned evidence record and comparison) | ✔ | richer views |
| C1 Risk fingerprint (rule-based) | ✔ | ML attribution |
| C3 Virtual pivotal (statistical simulation) | ✔ | model-informed simulation |
| C4 Sensitivity / failure conditions | — | ✔ (Stage 20) |
| C7 Next best experiment | — | ✔ (Stage 21) |
| C2 Formulation optimisation | — | ✔ (Stage 22) |
| Fetch Missing Information | — | ✔ (Stage 23) |
| C6 Historical data, consent, ML | — | ✔ (Stages 24–26) |
| Optional AI assistance | — | ✔ (Stage 27, if approved) |
| SaaS hosting for customers | — | ✔ (Stages 28–29) |

## 4. Proposed MVP (OD-13)
**Approved by the owner on 2026-10-18 (ADR-030).** Stages 1–10 and 12–19, running locally, with synthetic data until OD-12(a) is resolved.

**Why this boundary:** it gives a complete, honest workflow: project → scenario → evidence → readiness → reviewed calculations → immutable run → report → comparison. Two differentiators are included (C1 rule-based, C3 simulation) and do not depend on ML or historical data. C5 is included through versioning and comparison.

**MVP limits that must be stated to any demo audience:**
- Only methods approved by the scientific reviewer appear. If none are approved, those outputs are unavailable rather than guessed.
- Green status is disabled.
- No BE success probability is shown (no validated model).
- Local only. Not a hosted product yet.

**Critical non-software dependency:** a qualified scientific reviewer (OD-10) and authoritative ruleset sources (OD-09) must be in place by Stage 12, or Stages 12–19 cannot pass.

## 5. Minimum dataset principle
No evidence section is mandatory for saving work. Each approved method declares its own minimum dataset. Readiness shows, per output, what is missing and how much it matters. The precise minimum datasets are part of the method approvals (Stages 12–14), not invented here.

## 6. Non-goals
- Storing participant-level clinical data (ADR-012).
- PBPK or mechanistic absorption modelling (not planned; would need a separate decision and validation).
- Regulatory submission authoring.
- Guaranteeing or certifying BE outcomes.
- Claims of GDPR compliance, GxP validation or certification, unless separately established by qualified parties.
