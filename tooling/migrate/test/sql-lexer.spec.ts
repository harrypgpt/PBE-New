import { maskSql, splitStatements } from '../src/sql-lexer';

describe('maskSql', () => {
  it('blanks line and nested block comments', () => {
    const out = maskSql('SELECT 1; -- DROP TABLE x\n/* a /* DROP */ b */ SELECT 2;');
    expect(out).not.toMatch(/DROP/);
    expect(out).toContain('SELECT 1;');
    expect(out).toContain('SELECT 2;');
  });

  it('blanks string literals, including doubled quotes and E-strings with backslashes', () => {
    const out = maskSql("SELECT 'it''s DROP', E'a\\'DROP b', 'ok';");
    expect(out).not.toMatch(/DROP/);
    expect(out.trim().endsWith(';')).toBe(true);
  });

  it('blanks quoted identifiers', () => {
    expect(maskSql('CREATE TABLE "DROP" (x int);')).not.toMatch(/DROP/);
  });

  it('blanks dollar-quoted bodies, tagged and untagged', () => {
    const out = maskSql(
      'DO $$ BEGIN COMMIT; END $$; CREATE FUNCTION f() RETURNS int AS $fn$ SELECT 1; DROP $fn$ LANGUAGE sql;',
    );
    expect(out).not.toMatch(/COMMIT|DROP|BEGIN/);
    expect(out).toMatch(/^DO\s+;/);
  });

  it('keeps line breaks so line numbers stay correct', () => {
    const sql = "SELECT 'a\nb';\n-- c\nSELECT 1;";
    expect(maskSql(sql).split('\n')).toHaveLength(sql.split('\n').length);
  });
});

describe('splitStatements', () => {
  it('returns statements with their starting line', () => {
    const st = splitStatements(maskSql('-- header\nCREATE SCHEMA a;\n\nCREATE SCHEMA b;\n'));
    expect(st).toEqual([
      { text: 'CREATE SCHEMA a', line: 2 },
      { text: 'CREATE SCHEMA b', line: 4 },
    ]);
  });

  it('ignores semicolons inside literals and bodies', () => {
    expect(splitStatements(maskSql("SELECT ';'; DO $$ BEGIN PERFORM 1; END $$;"))).toHaveLength(2);
  });
});
