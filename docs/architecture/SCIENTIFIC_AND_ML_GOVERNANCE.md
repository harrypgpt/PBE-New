# Scientific and ML Governance

Status: Draft for product-owner review, MA-00, 2026-10-16.
**No formulas, thresholds, regulatory parameters or performance figures are defined in this document.** Each must come from an authoritative source and pass qualified scientific review (OD-09, OD-10) before implementation.

## 1. Separation of concerns

| Layer | What it is | Can run without the next layer? | Governance |
|---|---|---|---|
| Deterministic science (S1–S4, S8) | Reviewed calculations and rules | Yes | Method lifecycle (§2) |
| Statistical simulation (S3, S6) | Reviewed statistical methods with stated assumptions | Yes | Method lifecycle (§2) |
| Predictive ML (S5) | Trained models | Optional; never a prerequisite | Model lifecycle (§6) |
| Optional AI assistance (S9) | Suggestions to humans | Optional | AI rules (§7) |

## 2. Scientific method lifecycle

1. **Proposal:** method id, purpose, authoritative references, the formulas *as written in the source*, assumptions, applicability conditions, input and output units, and known limitations.
2. **Known-answer test set:** reference inputs and outputs from an independent source (a published example, a validated reference implementation, or reviewer-prepared hand calculations), with tolerances and a justification for each tolerance.
3. **Implementation** in `science-core` as a versioned, pure function.
4. **Software verification:** unit tests plus KATs pass in `verify`.
5. **Scientific review:** a named qualified reviewer (OD-10) checks the formula transcription, assumptions, applicability and KAT results, and records approval in `platform.method_version`.
6. **Release:** only approved method versions can be used in prediction runs. Draft methods can run only in a clearly labelled sandbox mode, if one is approved.
7. **Change:** any behaviour change creates a new version and repeats steps 2–5. Old versions stay available for reproducing earlier runs.
8. **Retirement:** marked retired. It is never deleted.

Software tests passing (step 4) is **not** scientific validation (step 5). Neither is predictive-model validation (§6).

### 2.1 Candidate method areas (for reviewer selection; nothing here is approved)
- Dissolution profile comparison approaches, including whether and when similarity-factor style comparisons apply.
- Summary-statistic BE assessment: GMR and 90% CI handling for Cmax and AUC.
- ISCV handling, including the relationship between reported variability measures and the design.
- Power and sample-size methods for supported designs (e.g. 2×2 crossover, replicate designs). These take the endpoint, expected GMR, BE limits (from the ruleset), power, alpha, design, ISCV and dropout assumptions. **Sample size is never calculated from ISCV alone.**
- Evidence-quality scoring and readiness scoring (§3).

The reviewer decides which of these are in MVP and in what order (Stages 13–14).

### 2.2 Scientific rules that apply everywhere
- ISCV (intra-subject) and inter-subject variability are separate fields and are never substituted for each other.
- Fasting and fed studies are separate study contexts. Results are never pooled silently.
- In-vitro dissolution similarity alone never produces a statement that in-vivo BE is established.
- Units, method versions, assumptions and provenance are kept with every output.
- Cmax and AUC are evaluated separately, with endpoint-specific outputs.

## 3. Prediction readiness

- "Prediction readiness: NN%" is shown **only after** the scoring method is approved (OD-23, Stage 12). Until then the UI shows a checklist without a percentage.
- Readiness is **not** a probability of BE success, and the UI says so next to the number.
- Proposed structure, for review:
  1. **Hard gates per output:** scope supported, the method's minimum dataset present, units valid. Failing any gate gives Grey for that output.
  2. **Completeness:** share of the method's required and recommended fields present, with reviewer-approved weights.
  3. **Evidence quality:** origin and review state (e.g. reviewed experimental data vs assumption), with reviewer-approved weights.
  4. **Applicability:** whether inputs fall inside the method or model applicability domain.
- The breakdown is always shown, never only the single number.

## 4. Status colours

| Colour | Allowed when | Never when |
|---|---|---|
| Grey | Gates fail, scope unsupported, outside the applicability domain | — |
| Amber | An approved ruleset condition identifies important limitations or elevated uncertainty | — |
| Red | An approved, referenced rule identifies a scientifically justified high-risk condition | Missing data is the only reason |
| Green | Predefined, **validated** criteria are met | Criteria not validated. Until then Green is technically disabled and a test proves it cannot be produced. |

## 5. Outputs and their preconditions

| Output | Precondition before display |
|---|---|
| Cmax and AUC assessments, GMR, 90% CI | Approved S3 method; summary inputs present; design known |
| ISCV and variability measures | Approved method; source and type of variability recorded |
| Sample size (evaluable subjects, recommended enrolment) | Approved method; all inputs listed in §2.1 present, with assumptions shown; dropout assumption explicit |
| Simulated outcomes (C3) | Approved simulation method; seed and assumptions recorded |
| BE success probability | **Only** from an approved model version (§6) with validated calibration in its applicability domain. Otherwise not displayed. |
| Risk drivers (C1), next actions (C7), candidates (C2) | Approved rules or methods; limitation text attached |

**Mandatory limitation statement** on every result page and report, worded under OD-12. Proposed wording for review: *"PBE outputs are decision support. They can be wrong, depend on the evidence and assumptions shown, and require appropriate scientific and human judgement. They do not guarantee bioequivalence and do not replace any required regulatory study."* A test checks that it is present on every result view and report.

## 6. ML and historical-data governance (C6, S5)

1. **Ingestion:** only authorised studies, with provenance, data-quality checks, duplicate and related-study detection (same product, formulation lineage, sponsor program).
2. **Eligibility and consent:** each case passes an eligibility review and a valid consent check before it enters `training` (see [SECURITY_PRIVACY_AND_TENANCY.md §9](SECURITY_PRIVACY_AND_TENANCY.md#9-training-consent-c6)).
3. **Splits:** training, validation and an **independent test set**, using **group-aware** splits so that related studies or formulations never span splits (leakage prevention). The test set is locked before model development.
4. **Acceptance criteria** (metrics, calibration requirements, subgroup checks, minimum evidence) are **predefined** and approved before training (OD-11). No arbitrary minimum number of studies is assumed. Whether data is sufficient is a reviewer judgement against the criteria.
5. **Training record:** dataset snapshot ids, code version, hyperparameters, seed, environment. It must be reproducible.
6. **Evaluation:** discrimination, calibration, error analysis and applicability-domain characterisation, all recorded in `model_evaluation`.
7. **Promotion:** human approval by the platform owner and the platform scientific reviewer, recorded. Only one production version per model purpose.
8. **Rollback:** to any previously approved version, recorded.
9. **Monitoring (Stage 26):** compare predictions with later actual outcomes when consented outcomes arrive. Track calibration and drift. Defined triggers lead to review or suspension.
10. **Display rule:** an unvalidated model's probability is never shown to sponsors as reliable. Candidate models may be shown only to platform roles, labelled "candidate, not validated".

ML is implemented in TypeScript (ADR-005). The library approach is OD-19.

## 7. Optional AI assistance rules (S9)
- Disabled until OD-20 is approved (provider, data-processing agreement, tenant opt-in).
- AI never modifies inputs, calculations, results or reports. It only proposes, and humans decide (see [MODULE_BOUNDARIES.md §5](MODULE_BOUNDARIES.md#5-ai-isolation-rules-s9)).
- AI-originated suggestions are labelled and audited wherever they appear.
- Sponsor-confidential data is never sent externally without explicit approval.

## 8. Differentiating capabilities: scientific guardrails

| Cap. | Guardrail |
|---|---|
| C1 | Drivers are described as associations or rule triggers. Causal language is used only for evidence tagged as causal by a reviewer. Contribution type is always stated. |
| C2 | Outputs are candidate directions or ranges to *evaluate*, with evidence basis and confidence. No exact recipe unless validated relationships support it, and none are assumed today. |
| C3 | Simulated pass proportions are conditional on the stated assumptions and are labelled that way. They are not a BE success probability unless they come from a validated model. |
| C4 | Sensitivity results are conditional on the perturbation ranges chosen, and those ranges are shown. |
| C5 | Called a "digital twin" only in the sense of a versioned evidence record. A banner states that it is not a PBPK or mechanistic model. |
| C6 | Requires consent, eligibility, leakage controls and acceptance criteria. Nothing is reported as learned until validated. |
| C7 | Each recommendation states which uncertainty or risk it targets, why, and its limitations. It is not a guarantee that the experiment will change the outcome. |

## 9. Jurisdiction rulesets
- The regulatory-neutral core plus versioned rulesets per jurisdiction or guideline (OD-09). A ruleset holds limits, design requirements, conditions and Amber/Red rules, each with a citation and a reviewer approval.
- A run pins one ruleset version. Comparing runs with different ruleset versions is flagged.
