import {
  DOSAGE_FORMS,
  PRODUCT_FLAGS,
  RELEASE_TYPES,
  ROUTES,
  type VocabularyTerm,
} from '@pbe/contracts';

/**
 * Display labels for the controlled vocabulary (draft, ADR-011; reviewer confirmation in Stage 12).
 * Every option shown in a form comes from the shared vocabulary, so the screen can never offer a
 * term the API would refuse. An unknown stored code is shown as-is, never hidden.
 */
const labelOf = (terms: readonly VocabularyTerm[], code: string): string =>
  terms.find((t) => t.code === code)?.label ?? code;

export const dosageFormLabel = (code: string) => labelOf(DOSAGE_FORMS, code);
export const routeLabel = (code: string) => labelOf(ROUTES, code);
export const releaseTypeLabel = (code: string) => labelOf(RELEASE_TYPES, code);
export const productFlagLabel = (code: string) => labelOf(PRODUCT_FLAGS, code);

export const options = (terms: readonly VocabularyTerm[]) =>
  terms.map((t) => ({ value: t.code, label: t.label }));

export const formatStrength = (s: { readonly value: number; readonly unit: string }) =>
  `${s.value.toLocaleString('en-GB', { maximumFractionDigits: 6 })} ${s.unit}`;
