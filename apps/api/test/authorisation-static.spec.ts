import fs from 'node:fs';
import path from 'node:path';
import { ROLE_TEMPLATES } from '@pbe/contracts';

/*
 * S7-9 static check (STAGE-07-PLAN.md §5): no authorisation code decides by a role NAME or
 * template key. Roles are configurable per organisation (F-4), so only stable permission
 * identifiers may be checked. "Authorisation code" here is the code that decides access:
 *  - the per-request guard (common/route.ts);
 *  - the access decision (modules/tenancy/access.ts);
 *  - the query that loads a member's effective permissions (membershipOf in modules/db/tenancy.ts).
 */

const SRC = path.join(__dirname, '..', 'src');
const read = (p: string) => fs.readFileSync(path.join(SRC, p), 'utf8');

/** The source text of one method of the tenancy data-access object. */
function methodSource(file: string, name: string): string {
  const text = read(file);
  const start = text.indexOf(`async ${name}(`);
  if (start === -1) throw new Error(`${name} not found in ${file}`);
  const end = text.indexOf('\n  },\n', start);
  return text.slice(start, end);
}

const DECISION_CODE: ReadonlyArray<[string, string]> = [
  ['common/route.ts', read('common/route.ts')],
  ['modules/tenancy/access.ts', read('modules/tenancy/access.ts')],
  ['modules/db/tenancy.ts membershipOf', methodSource('modules/db/tenancy.ts', 'membershipOf')],
];

const FORBIDDEN: ReadonlyArray<[string, RegExp]> = [
  ...ROLE_TEMPLATES.flatMap((t): Array<[string, RegExp]> => [
    [`template key "${t.key}"`, new RegExp(t.key, 'i')],
    [`role name "${t.name}"`, new RegExp(t.name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'), 'i')],
  ]),
  ['a template key lookup', /template_?key/i],
  ['a role-name comparison', /\.name\s*(===|!==|==|!=)|\bname\s*:\s*['"`]/],
  ['a role-name column', /['"`]name['"`]/],
];

describe('S7-9 no authorisation decision depends on a role name', () => {
  it.each(DECISION_CODE)(
    '%s checks permissions only, never role names or template keys',
    (_file, text) => {
      const hits = FORBIDDEN.filter(([, re]) => re.test(text)).map(([what]) => what);
      expect(hits).toEqual([]);
    },
  );

  it('the effective-permission query reads only role memberships and their permission identifiers', () => {
    const q = methodSource('modules/db/tenancy.ts', 'membershipOf');
    expect(q).toContain("selectFrom('app.membership_role as mr')");
    expect(q).toContain("innerJoin('app.role_permission as rp'");
    expect(q).toContain(".select('rp.permission')");
    expect(q).not.toMatch(/app\.role['"\s]/); // the role table (with its name) is not consulted
  });

  it('the check itself is not vacuous: a role-name test in decision code would be reported', () => {
    const planted = `${DECISION_CODE[1]![1]}\nif (role.name === 'Tenant Administrator') allow();`;
    expect(FORBIDDEN.filter(([, re]) => re.test(planted)).map(([w]) => w)).toEqual(
      expect.arrayContaining(['role name "Tenant Administrator"', 'a role-name comparison']),
    );
  });
});
