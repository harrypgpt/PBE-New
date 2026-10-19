import {
  DOSAGE_FORMS,
  PERMISSION_CODES,
  PERMISSION_PATTERN,
  PERMISSIONS,
  permissionsForSchema,
  PROJECT_ROUTES,
  ROLE_TEMPLATES,
  roleTemplatesForSchema,
  PRODUCT_FLAGS,
  ProjectInputSchema,
  RELEASE_TYPES,
  ROUTES,
  ScenarioInputSchema,
  VOCABULARY_STATUS,
  VOCABULARY_VERSION,
} from '@pbe/contracts';
import { formatScenarioCode, nextScenarioCode } from '../src/modules/projects/scenario-code';
import { checkScope, type ScopeInput } from '../src/modules/projects/scope';

/* Stage 8 independent parts (STAGE-08-PLAN.md §9): vocabulary, scope check, codes, validation. */

const IR_TABLET: ScopeInput = {
  dosageForm: 'tablet',
  route: 'oral',
  releaseType: 'immediate_release',
  productFlags: [],
};

describe('controlled vocabulary (DRAFT, ADR-011 only)', () => {
  const all = [...DOSAGE_FORMS, ...ROUTES, ...RELEASE_TYPES, ...PRODUCT_FLAGS];

  it('is flagged as a draft pending the scientific reviewer, with a version', () => {
    expect(VOCABULARY_STATUS).toBe('draft-pending-reviewer-confirmation');
    expect(VOCABULARY_VERSION).toMatch(/^draft-/);
  });

  it('contains exactly the ADR-011 terms; any change must be a deliberate, reviewed edit', () => {
    const snapshot = Object.fromEntries(all.map((t) => [t.code, t.scope]));
    expect(snapshot).toEqual({
      tablet: 'supported',
      capsule: 'supported',
      chewable_tablet: 'needs_review',
      orodispersible_tablet: 'needs_review',
      oral_solution: 'unsupported',
      oral_suspension: 'unsupported',
      oral: 'supported',
      parenteral: 'unsupported',
      inhalation: 'unsupported',
      topical: 'unsupported',
      transdermal: 'unsupported',
      nasal: 'unsupported',
      ophthalmic: 'unsupported',
      rectal: 'unsupported',
      vaginal: 'unsupported',
      immediate_release: 'supported',
      extended_release: 'unsupported',
      delayed_release: 'unsupported',
      pulsatile_release: 'unsupported',
      fixed_dose_combination: 'needs_review',
      biologic: 'unsupported',
      locally_acting: 'unsupported',
      complex_or_combination_product: 'unsupported',
    });
  });

  it('every term cites ADR-011; every non-supported term has a plain reason; codes are unique', () => {
    for (const t of all) {
      expect(t.source).toMatch(/ADR-011/);
      if (t.scope !== 'supported') expect(t.reason?.length ?? 0).toBeGreaterThan(20);
    }
    expect(new Set(all.map((t) => t.code)).size).toBe(all.length);
  });
});

describe('S8-2 scope check', () => {
  it('immediate-release oral tablets and capsules are supported', () => {
    for (const dosageForm of ['tablet', 'capsule']) {
      expect(checkScope({ ...IR_TABLET, dosageForm })).toEqual({
        status: 'supported',
        reasons: [],
        awaitingReviewer: false,
        vocabularyVersion: VOCABULARY_VERSION,
      });
    }
  });

  it.each([
    ['extended release', { releaseType: 'extended_release' }, /modified release/],
    ['delayed release', { releaseType: 'delayed_release' }, /modified release/],
    ['pulsatile release', { releaseType: 'pulsatile_release' }, /modified release/],
    ['oral solution', { dosageForm: 'oral_solution' }, /Oral solutions/],
    ['oral suspension', { dosageForm: 'oral_suspension' }, /Oral suspensions/],
    ['parenteral', { route: 'parenteral' }, /Parenteral/],
    ['inhalation', { route: 'inhalation' }, /Inhalation/],
    ['topical', { route: 'topical' }, /Topical/],
    ['transdermal', { route: 'transdermal' }, /Transdermal/],
    ['nasal', { route: 'nasal' }, /Nasal/],
    ['ophthalmic', { route: 'ophthalmic' }, /Ophthalmic/],
    ['rectal', { route: 'rectal' }, /Rectal/],
    ['vaginal', { route: 'vaginal' }, /Vaginal/],
    ['biologic', { productFlags: ['biologic'] }, /Biologics/],
    ['locally acting', { productFlags: ['locally_acting'] }, /Locally acting/],
    [
      'complex product',
      { productFlags: ['complex_or_combination_product'] },
      /unless separately validated/,
    ],
  ])('%s is unsupported, with the reason', (_l, change, reason) => {
    const r = checkScope({ ...IR_TABLET, ...change } as ScopeInput);
    expect(r.status).toBe('unsupported');
    expect(r.awaitingReviewer).toBe(false);
    expect(r.reasons).toHaveLength(1);
    expect(r.reasons[0]).toMatch(reason);
  });

  it.each([
    ['chewable tablet', { dosageForm: 'chewable_tablet' }],
    ['orodispersible tablet', { dosageForm: 'orodispersible_tablet' }],
    ['fixed-dose combination', { productFlags: ['fixed_dose_combination'] }],
  ])('borderline %s is NOT supported until the scientific reviewer includes it', (_l, change) => {
    const r = checkScope({ ...IR_TABLET, ...change } as ScopeInput);
    expect(r.status).toBe('unsupported');
    expect(r.awaitingReviewer).toBe(true);
    expect(r.reasons[0]).toMatch(/scientific reviewer explicitly includes it \(OD-10\)/);
  });

  it('an unknown term is never treated as supported', () => {
    const r = checkScope({ ...IR_TABLET, dosageForm: 'lozenge' });
    expect(r).toMatchObject({ status: 'unsupported', awaitingReviewer: false });
    expect(r.reasons).toEqual(['The dosage form "lozenge" is not in the controlled vocabulary.']);
  });

  it('lists every reason when several apply (and each flag once)', () => {
    const r = checkScope({
      dosageForm: 'oral_suspension',
      route: 'nasal',
      releaseType: 'extended_release',
      productFlags: ['biologic', 'biologic'],
    });
    expect(r.status).toBe('unsupported');
    expect(r.reasons).toHaveLength(4);
  });
});

describe('S8-3 scenario codes', () => {
  it('start at F001 and follow the highest existing code; never reuse a number', () => {
    expect(nextScenarioCode([])).toBe('F001');
    expect(nextScenarioCode(['F001'])).toBe('F002');
    expect(nextScenarioCode(['F001', 'F003'])).toBe('F004'); // the gap F002 is not refilled
    expect(nextScenarioCode(['F009'])).toBe('F010');
    expect(nextScenarioCode(['F999'])).toBe('F1000');
  });

  it('formats the database counter value; refuses non-positive or fractional numbers', () => {
    expect([1, 2, 99, 100, 1000].map(formatScenarioCode)).toEqual([
      'F001',
      'F002',
      'F099',
      'F100',
      'F1000',
    ]);
    for (const bad of [0, -1, 1.5, Number.NaN]) expect(() => formatScenarioCode(bad)).toThrow();
  });

  it('refuses anything that is not a scenario code', () => {
    for (const bad of ['F01', 'f001', 'G001', 'F001 ', 'F-001', '']) {
      expect(() => nextScenarioCode([bad])).toThrow(/Not a scenario code/);
    }
  });
});

describe('Decision 2: permission identifiers', () => {
  it('every catalogue code passes the shared naming validator; the draft name would not', () => {
    for (const p of PERMISSIONS)
      expect([p.code, PERMISSION_PATTERN.test(p.code)]).toEqual([p.code, true]);
    expect(PERMISSION_PATTERN.test('tenant.allprojects.read')).toBe(true);
    expect(PERMISSION_PATTERN.test('tenant.projects.read_all')).toBe(false);
  });

  it('every project route and template uses only catalogue codes', () => {
    for (const r of PROJECT_ROUTES) {
      expect(r.access.kind).toBe('permission');
      if (r.access.kind === 'permission')
        expect(PERMISSION_CODES.has(r.access.permission)).toBe(true);
    }
    for (const t of ROLE_TEMPLATES)
      for (const p of t.permissions) expect(PERMISSION_CODES.has(p)).toBe(true);
  });

  it('decision 1: the Tenant Administrator template holds all five project permissions', () => {
    const admin = ROLE_TEMPLATES.find((t) => t.key === 'tenant_administrator')!;
    expect(admin.permissions).toEqual(
      expect.arrayContaining([
        'tenant.projects.read',
        'tenant.allprojects.read',
        'tenant.projects.create',
        'tenant.projects.manage',
        'tenant.scenarios.manage',
      ]),
    );
  });

  it('decision 3: the base schema (0004) has none of the project permissions; 0006 has all five', () => {
    const codes = (v: number) => permissionsForSchema(v).map((p) => p.code);
    expect(codes(4).filter((c) => /projects|scenarios/.test(c))).toEqual([]);
    expect(codes(6).filter((c) => /projects|scenarios/.test(c))).toHaveLength(5);
    expect(
      roleTemplatesForSchema(4)
        .flatMap((t) => t.permissions)
        .filter((c) => /projects|scenarios/.test(c)),
    ).toEqual([]);
  });
});

describe('S8-1 validation rules', () => {
  const valid = {
    name: 'Fictional generic project',
    molecule: 'Fictionalol',
    strength: { value: 50, unit: 'mg' },
    dosageForm: 'tablet',
    route: 'oral',
    releaseType: 'immediate_release',
  };

  it('accepts a complete project; flags default to none; text is trimmed', () => {
    const p = ProjectInputSchema.parse({ ...valid, name: '  Fictional  ' });
    expect(p.name).toBe('Fictional');
    expect(p.productFlags).toEqual([]);
  });

  it.each([
    ['missing name', { name: '' }],
    ['name too long', { name: 'x'.repeat(201) }],
    ['missing molecule', { molecule: '   ' }],
    ['zero strength', { strength: { value: 0, unit: 'mg' } }],
    ['negative strength', { strength: { value: -5, unit: 'mg' } }],
    ['infinite strength', { strength: { value: Number.POSITIVE_INFINITY, unit: 'mg' } }],
    ['unknown unit', { strength: { value: 5, unit: 'mmol' } }],
    ['free-text dosage form', { dosageForm: 'Tablet (film-coated)' }],
    ['unknown route', { route: 'buccal' }],
    ['unknown release type', { releaseType: 'sustained' }],
    ['repeated flag', { productFlags: ['biologic', 'biologic'] }],
    ['extra field', { scopeStatus: 'supported' }],
  ])('rejects %s', (_l, change) => {
    expect(ProjectInputSchema.safeParse({ ...valid, ...change }).success).toBe(false);
  });

  it('accepts unsupported but known terms (recorded and marked, not refused)', () => {
    expect(
      ProjectInputSchema.safeParse({ ...valid, route: 'nasal', releaseType: 'extended_release' })
        .success,
    ).toBe(true);
  });

  it('scenario description: optional, trimmed, at most 500 characters; no code can be supplied', () => {
    expect(ScenarioInputSchema.parse({})).toEqual({ description: '' });
    expect(ScenarioInputSchema.safeParse({ description: 'x'.repeat(501) }).success).toBe(false);
    expect(ScenarioInputSchema.safeParse({ code: 'F001' }).success).toBe(false);
  });
});
