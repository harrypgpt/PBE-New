import {
  DOSAGE_FORMS,
  PRODUCT_FLAGS,
  RELEASE_TYPES,
  ROUTES,
  VOCABULARY_VERSION,
  type VocabularyTerm,
} from '@pbe/contracts';

/**
 * Scope check (ADR-011, STAGE-08-PLAN.md §3). A project is "supported" ONLY when its dosage form,
 * route and release type are all supported terms and no product characteristic takes it out of
 * scope. Anything else is "unsupported" with every reason listed: unknown terms, unsupported
 * terms, and borderline terms the scientific reviewer has not (yet) included (OD-10). Runs for an
 * unsupported project are blocked (later stages); the reason is always shown.
 */
export interface ScopeInput {
  readonly dosageForm: string;
  readonly route: string;
  readonly releaseType: string;
  readonly productFlags: readonly string[];
}

export interface ScopeResult {
  readonly status: 'supported' | 'unsupported';
  readonly reasons: readonly string[];
  /** True when at least one reason is a borderline term awaiting the scientific reviewer. */
  readonly awaitingReviewer: boolean;
  readonly vocabularyVersion: string;
}

function judge(
  terms: readonly VocabularyTerm[],
  code: string,
  what: string,
): { reason: string | null; review: boolean } {
  const term = terms.find((t) => t.code === code);
  if (!term)
    return { reason: `The ${what} "${code}" is not in the controlled vocabulary.`, review: false };
  if (term.scope === 'supported') return { reason: null, review: false };
  return {
    reason: term.reason ?? `${term.label} is outside the supported scope.`,
    review: term.scope === 'needs_review',
  };
}

export function checkScope(input: ScopeInput): ScopeResult {
  const results = [
    judge(DOSAGE_FORMS, input.dosageForm, 'dosage form'),
    judge(ROUTES, input.route, 'route'),
    judge(RELEASE_TYPES, input.releaseType, 'release type'),
    ...[...new Set(input.productFlags)].map((f) =>
      judge(PRODUCT_FLAGS, f, 'product characteristic'),
    ),
  ];
  const reasons = results.map((r) => r.reason).filter((r): r is string => r !== null);
  return {
    status: reasons.length === 0 ? 'supported' : 'unsupported',
    reasons,
    awaitingReviewer: results.some((r) => r.review),
    vocabularyVersion: VOCABULARY_VERSION,
  };
}
