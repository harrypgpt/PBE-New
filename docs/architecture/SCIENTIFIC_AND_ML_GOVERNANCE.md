# PBE — Scientific and ML Governance

> **Status:** Baseline v0.2 (2026-10-13; v0.2: all methods and ML in TypeScript, no Python, per ADR-022). This document sets **rules for how scientific methods and models are admitted**. It deliberately **does not** fix numerical regulatory parameters or claim any model performance. Those must come from cited sources and real evaluations, approved by a qualified scientific reviewer (OD-024).

---

## 1. Principles

1. **No invented science.** Every formula, threshold and parameter in PBE needs a method specification with a citation to a primary source, such as a regulatory guidance or a peer-reviewed publication, and sign-off by a qualified scientific reviewer.
2. **Layer separation.** L1 deterministic, L2 statistical, L3 ML, L4 capability engines and L5 optional AI are governed separately (ADR-006). **L5 never produces or alters a scientific value.**
3. **Observed ≠ derived ≠ predicted.** Value origin is always explicit (ADR-011). Predictions and simulations live only in run outputs.
4. **Uncertainty is mandatory.** Every predicted or simulated quantity comes with an uncertainty representation (interval, distribution summary or qualitative band with justification) and an applicability statement.
5. **Fail closed.** If inputs are outside the validated applicability domain, PBE does **not** produce the output. It explains why and what evidence would help.
6. **Reproducibility.** Same snapshot + same method/model versions + same seed ⇒ same output hash.

## 2. Method lifecycle (L1, L2, L4)

```
DRAFT spec → REVIEWED (scientific reviewer) → IMPLEMENTED → VERIFIED (test vectors pass)
          → APPROVED (owner + reviewer) → ACTIVE → DEPRECATED → RETIRED (kept for reproduction)
```

Each method has a `docs/methods/<method-id>/<version>.md` specification containing:
- Purpose, scope and explicit **out-of-scope** conditions.
- Inputs (with units), outputs (with units) and assumptions.
- Mathematical definition, **with citation(s)**.
- Numerical approach (e.g., exact vs approximation) and expected precision.
- **Implementation language:** TypeScript (ADR-008, ADR-022). If a method cannot be implemented and validated in TypeScript, it is not offered.
- **Test vectors:** input/expected-output pairs from an independent, named reference source. This can be a published worked example, or output from a named reference implementation that someone *actually ran*, with the tool name, version and date recorded. **Never hand-typed "expected" numbers without such a source.** Reference tools are run by the reviewer **outside** PBE. They are never added to the PBE repository, CI or runtime. Only the resulting vector files, with their provenance, are committed.
- Validation status and reviewer sign-off.

A method version is **never edited** after approval. Changes create a new version. Retired versions stay executable, so historical runs can be reproduced.

## 3. Statistical requirements already known to need care

These are **requirements on the method specs**, not the method specs themselves.

### 3.1 ISCV (intra-subject / within-subject coefficient of variation)
- Store and handle ISCV **separately** from inter-subject (between-subject) CV and total CV.
- ISCV derived from a crossover analysis must state: the design, the log-transformation, the variance component used (e.g., residual mean square error from the specified model), and the conversion formula between log-scale variance and CV. Each needs a citation.
- For replicate designs, the method spec must distinguish within-subject variability of the reference (e.g., CVwR) from that of the test, where the design allows.
- Each ISCV value records its origin: *reported* (with source), *derived* (method version + inputs) or *assumed* (planning parameter, labelled).
- A parallel design does not give ISCV. The system must not label parallel-design variability as ISCV.

### 3.2 Point estimate and confidence intervals
- GMR and 90% CI from pilot data must specify: the statistical model (e.g., ANOVA with sequence, subject-within-sequence, period, and treatment effects for a 2×2×2 crossover, per the cited guidance), log-transformation, degrees of freedom and handling of missing periods/dropouts.
- When only summary statistics are supplied, PBE stores them as **reported** and does not recompute them unless enough data and a validated method exist.

### 3.3 Sample size and power
- Sample size is **never** calculated from ISCV alone. The method must take: endpoint, expected/assumed GMR, equivalence limits (from the jurisdiction ruleset), study design, target power, significance level (α), dropout allowance, and the variability measure appropriate to the design. All of these are recorded as run parameters.
- The method spec states which power calculation it implements (e.g., exact TOST power vs a named approximation) and its validated range.
- Multiple endpoints (e.g., Cmax and AUC) are evaluated per endpoint. Any combined result must be defined explicitly in the spec.
- Reference-scaled approaches for highly variable drugs, and tightened limits for narrow-therapeutic-index drugs, are **only** available once their jurisdiction-specific methods are specified, cited and validated (OD-010, OD-011).

### 3.4 Dissolution
- Dissolution comparison metrics (e.g., the f2 similarity factor) may be computed only when the conditions in the selected **jurisdiction ruleset** are satisfied. Each condition is cited. When the conditions are not met, PBE reports "metric not applicable" with reasons and does not compute or display a value.
- **Dissolution similarity alone never yields a BE conclusion or BE probability.** At most it is one input among others, with its contribution explained (C1).

### 3.5 Study designs
Only designs with `analysis_supported = true` (DATA §4.5) can be analysed. Proposed initial target: 2×2×2 crossover. The order in which other designs (e.g., 3-period partial replicate, 4-period full replicate, parallel) are added is OD-011.

## 4. Rulesets (readiness, applicability, jurisdiction parameters)

- Rulesets are versioned documents (ADR-014). Each rule has an ID, a plain-language description, a machine condition, severity (BLOCKER / WARNING / INFO), a citation or rationale, author and reviewer.
- **Readiness:** for each run type, the required and recommended inputs, with missing-data guidance text.
- **Applicability domain:** product scope (IR oral solid only, initially), method-specific domains and model-specific domains (feature ranges, categories seen in training, distance-to-training measures once a model exists).
- **Jurisdiction parameters:** e.g., equivalence limits, CI level and dissolution-metric conditions. **No value is entered without a citation to the current version of the source guidance**, verified by a qualified person (OD-010).

## 5. ML governance (L3)

### 5.1 Data eligibility
Training data must satisfy all of: valid consent (SECURITY §10), a frozen source Dataset Version, approved values only, verified outcome labels, and no erasure or legal-hold flag. Eligibility is evaluated at a recorded *consent snapshot time* and stored with the training dataset.

### 5.2 Leakage prevention
- **Grouped splits.** All records from the same drug substance + sponsor + product family (exact grouping key: OD-020) go into the same split, so a test set never shares a product with training.
- **Temporal holdout** (where data allows): the test set contains studies completed after the training cutoff.
- **Pilot-to-pivotal pairs** stay together. A pivotal outcome must never be a feature for its own pilot.
- **No target leakage.** Features must be available *before* the pivotal study. A feature-availability check in the data pipeline enforces this.
- The **test set is locked**. It is used once per candidate for final evaluation, and access is logged. Hyper-parameter tuning uses the validation split or cross-validation within training only.
- Duplicates and near-duplicates are detected across splits before training.

### 5.3 Pre-registered acceptance criteria
Before any training, the owner and the scientific reviewer register **acceptance criteria**: metrics (e.g., discrimination, calibration, error on ratio predictions), minimum thresholds, required subgroup checks and minimum test-set size. Specific metrics and thresholds: **OD-020**. **No thresholds are proposed in this document**, because they must come from the reviewers and the intended use.

### 5.4 Model lifecycle
```
CANDIDATE → EVALUATED → (fails criteria → REJECTED)
                      → (meets criteria) → VALIDATED → owner APPROVED → PRODUCTION
PRODUCTION → RETIRED (superseded / consent policy / drift)
```
- Promotion requires the owner's explicit action with a written rationale, recorded in `promotion_decisions`.
- Only one PRODUCTION version per model family at a time. Rollback = promote the previous VALIDATED version (audited).
- Each model version stores: training dataset ID and hash, code commit, hyperparameters, artifact hash, feature schema, applicability-domain definition, evaluation reports.
- Training and inference run in TypeScript inside PBE's governed environment (`packages/ml-core`; OD-007, OD-008). Models trained outside PBE, or with Python tooling, cannot be registered. Their consent, leakage and reproducibility controls could not be verified.

### 5.5 Inference rules
- Use the PRODUCTION model only. Record the model version in the run.
- Check the applicability domain per input. If outside, block or warn as the model's governance specifies. The default is block.
- Output a prediction **with uncertainty** and the model's documented limitations.
- Never report a model's accuracy unless it comes from a stored evaluation record. The UI shows evaluation results by reference to that record.

### 5.6 Monitoring
- Track input-distribution drift against the training data (aggregate only).
- When outcomes later become known (with consent), record prediction-vs-outcome for future evaluation, but never retrain automatically. Retraining is a governed owner action.

## 6. Run reproducibility contract

A run is reproducible when the following are stored:
- frozen Dataset Version ID + content hash,
- canonical input snapshot + hash,
- run parameters (including all *assumed* values),
- method IDs/versions, ruleset versions, model version (if any), engine version,
- application build/commit identifier,
- random seed and simulation count (for stochastic methods).

**Reproduce** re-executes using the stored references and compares output hashes. A mismatch is a defect and is reported as one. It is never hidden.

## 7. Capability-specific governance

| Capability | Key governance rule |
|---|---|
| C1 Risk Fingerprint | Each driver shows *how* it was identified (rule ID or attribution method + version). Rule-based drivers must not be presented as model-derived causation |
| C2 Formulation Optimization | Recommendations stay within the model's applicability domain and user constraints. Each candidate is labelled "hypothesis for experimental confirmation", never "predicted to pass" |
| C3 Virtual BE | All assumptions listed. Results shown as simulated proportions with simulation count and seed. Not called a "probability of BE success" unless the assumptions' uncertainty is propagated by a validated method |
| C4 Sensitivity | Parameter ranges are user-stated or rule-derived and shown. The engine identifies conditions where outcomes cross thresholds, under stated assumptions |
| C5 Digital Twin | Defined as a versioned evidence-and-results representation. It is not a mechanistic or PBPK simulation unless such a method is separately validated (OD-030). Validity limits are displayed |
| C6 Failure / Pilot-to-Pivotal Learning | Subject to all §5 rules. Failed and borderline cases are included only with consent and verified labels. Class imbalance is reported, not hidden |
| C7 Next Best Action | Each recommendation cites the gap or sensitivity driving it. v1 ranking is rule-based and labelled as such. Recommendations are suggestions for expert review |

## 8. Optional AI assistance (L5) boundaries

Allowed (after enabling per SECURITY §8): suggest field mappings for human review, summarise uploaded text for navigation, draft explanatory prose from already-computed run outputs, which is shown as a draft and labelled as AI-generated.
**Not allowed:** generating, estimating or correcting any scientific value; choosing methods; deciding applicability; ranking recommendations; writing anything into evidence or run outputs without human approval through the normal provenance path.

## 9. Scope extension procedure

Extending scope (new dosage form, route, design or jurisdiction) requires: a scope-extension proposal, updated rulesets and method specs, new test vectors, re-evaluation of any affected model on in-scope data for the new domain, and reviewer + owner approval. It is tracked as a roadmap stage.

## 10. Scientific acceptance before production

No prediction engine (L3, or L4 using L3) is enabled in production until:
1. method specs and rulesets are approved,
2. test vectors pass in CI,
3. pre-registered acceptance criteria are met on the locked test set, with the evaluation record stored,
4. limitations and the applicability domain are documented and shown in the UI,
5. the owner has approved promotion.
