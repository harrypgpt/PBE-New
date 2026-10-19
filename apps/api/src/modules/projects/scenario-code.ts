import { SCENARIO_CODE_PATTERN } from '@pbe/contracts';

/**
 * Scenario codes F001, F002, … per project (STAGE-08-PLAN.md D8-7). The next code follows the
 * HIGHEST existing number, so a code is never reused (scenarios are not deleted in Stage 8; if
 * that changes, gaps still never get refilled). Uniqueness is also enforced by the database, and
 * the API allocates under a row lock so simultaneous additions get different codes.
 */
/** The code for scenario number n (1 → F001). The database counter supplies n under a row lock. */
export function formatScenarioCode(n: number): string {
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`Not a scenario number: ${n}`);
  return `F${String(n).padStart(3, '0')}`;
}

export function nextScenarioCode(existing: readonly string[]): string {
  let max = 0;
  for (const code of existing) {
    if (!SCENARIO_CODE_PATTERN.test(code)) {
      throw new Error(`Not a scenario code: "${code}"`);
    }
    max = Math.max(max, Number(code.slice(1)));
  }
  return formatScenarioCode(max + 1);
}
