/**
 * Controlled vocabulary for projects (Stage 8) — DRAFT.
 *
 * Built ONLY from the supported/unsupported scope table of ADR-011
 * (docs/PRODUCT_SCOPE_AND_MVP.md §2). No term or classification is added beyond it. It is
 * flagged for confirmation by the qualified scientific reviewer (OD-10) in Stage 12; until then
 * every borderline term is "needs_review", which the scope check treats as NOT supported.
 */

export const VOCABULARY_VERSION = 'draft-2026-10-18';
export const VOCABULARY_STATUS = 'draft-pending-reviewer-confirmation' as const;

export type TermScope = 'supported' | 'unsupported' | 'needs_review';

export interface VocabularyTerm {
  readonly code: string;
  readonly label: string;
  readonly scope: TermScope;
  /** Plain-language reason shown when the term is not supported. */
  readonly reason?: string;
  /** Where the classification comes from. */
  readonly source: string;
}

const ADR011 = 'ADR-011 (PRODUCT_SCOPE_AND_MVP.md §2)';
const REVIEW =
  'is in scope only if the scientific reviewer explicitly includes it (OD-10); until then it is treated as unsupported';

export const DOSAGE_FORMS: readonly VocabularyTerm[] = [
  { code: 'tablet', label: 'Tablet', scope: 'supported', source: ADR011 },
  { code: 'capsule', label: 'Capsule', scope: 'supported', source: ADR011 },
  {
    code: 'chewable_tablet',
    label: 'Chewable tablet',
    scope: 'needs_review',
    reason: `Chewable tablet ${REVIEW}.`,
    source: ADR011,
  },
  {
    code: 'orodispersible_tablet',
    label: 'Orodispersible tablet',
    scope: 'needs_review',
    reason: `Orodispersible (orally disintegrating) form ${REVIEW}.`,
    source: ADR011,
  },
  {
    code: 'oral_solution',
    label: 'Oral solution',
    scope: 'unsupported',
    reason:
      'Oral solutions are outside the supported scope (only immediate-release oral solid forms are supported).',
    source: ADR011,
  },
  {
    code: 'oral_suspension',
    label: 'Oral suspension',
    scope: 'unsupported',
    reason:
      'Oral suspensions are outside the supported scope (only immediate-release oral solid forms are supported).',
    source: ADR011,
  },
];

export const ROUTES: readonly VocabularyTerm[] = [
  { code: 'oral', label: 'Oral', scope: 'supported', source: ADR011 },
  ...(
    [
      ['parenteral', 'Parenteral'],
      ['inhalation', 'Inhalation'],
      ['topical', 'Topical'],
      ['transdermal', 'Transdermal'],
      ['nasal', 'Nasal'],
      ['ophthalmic', 'Ophthalmic'],
      ['rectal', 'Rectal'],
      ['vaginal', 'Vaginal'],
    ] as const
  ).map(([code, label]): VocabularyTerm => ({
    code,
    label,
    scope: 'unsupported',
    reason: `${label} products are outside the supported scope (only oral products are supported).`,
    source: ADR011,
  })),
];

export const RELEASE_TYPES: readonly VocabularyTerm[] = [
  { code: 'immediate_release', label: 'Immediate release', scope: 'supported', source: ADR011 },
  ...(
    [
      ['extended_release', 'Extended release'],
      ['delayed_release', 'Delayed release'],
      ['pulsatile_release', 'Pulsatile release'],
    ] as const
  ).map(([code, label]): VocabularyTerm => ({
    code,
    label,
    scope: 'unsupported',
    reason: `${label} (modified release) is outside the supported scope (only immediate release is supported).`,
    source: ADR011,
  })),
];

/** Product characteristics that take a product out of scope (or need the reviewer). */
export const PRODUCT_FLAGS: readonly VocabularyTerm[] = [
  {
    code: 'fixed_dose_combination',
    label: 'Fixed-dose combination',
    scope: 'needs_review',
    reason: `A fixed-dose combination ${REVIEW}.`,
    source: ADR011,
  },
  {
    code: 'biologic',
    label: 'Biologic',
    scope: 'unsupported',
    reason: 'Biologics are outside the supported scope.',
    source: ADR011,
  },
  {
    code: 'locally_acting',
    label: 'Locally acting',
    scope: 'unsupported',
    reason: 'Locally acting products are outside the supported scope.',
    source: ADR011,
  },
  {
    code: 'complex_or_combination_product',
    label: 'Complex or combination product',
    scope: 'unsupported',
    reason:
      'Complex or combination products are outside the supported scope unless separately validated.',
    source: ADR011,
  },
];

/** Strength units until the S1 unit registry exists (STAGE-08-PLAN.md D8-3). */
export const STRENGTH_UNITS = ['mg', 'g', 'µg'] as const;

const codes = (terms: readonly VocabularyTerm[]) =>
  terms.map((t) => t.code) as [string, ...string[]];
export const DOSAGE_FORM_CODES = codes(DOSAGE_FORMS);
export const ROUTE_CODES = codes(ROUTES);
export const RELEASE_TYPE_CODES = codes(RELEASE_TYPES);
export const PRODUCT_FLAG_CODES = codes(PRODUCT_FLAGS);
