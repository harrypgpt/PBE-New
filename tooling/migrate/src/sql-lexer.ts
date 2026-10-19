/**
 * Minimal SQL lexer used only for the runner's safety checks.
 *
 * `maskSql` blanks out comments, string literals, quoted identifiers and dollar-quoted bodies
 * (keeping line breaks), so keyword checks see only executable SQL text. This is a lexical
 * check, not a SQL parser: statements hidden inside dollar-quoted bodies (e.g. DO blocks or
 * function bodies) are deliberately not inspected. See DATA_AND_DATABASE_DESIGN.md §7.
 */
export function maskSql(sql: string): string {
  const out = sql.split('');
  const n = sql.length;
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < n; k += 1) if (out[k] !== '\n') out[k] = ' ';
  };
  let i = 0;
  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      blank(i, stop);
      i = stop;
    } else if (c === '/' && next === '*') {
      // PostgreSQL block comments nest.
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (sql[j] === '/' && sql[j + 1] === '*') {
          depth += 1;
          j += 2;
        } else if (sql[j] === '*' && sql[j + 1] === '/') {
          depth -= 1;
          j += 2;
        } else {
          j += 1;
        }
      }
      blank(i, j);
      i = j;
    } else if (c === "'" || c === '"') {
      const backslashEscapes = c === "'" && i > 0 && /[eE]/.test(sql[i - 1] ?? '');
      let j = i + 1;
      while (j < n) {
        if (backslashEscapes && sql[j] === '\\') {
          j += 2;
        } else if (sql[j] === c) {
          if (sql[j + 1] === c) {
            j += 2;
          } else {
            j += 1;
            break;
          }
        } else {
          j += 1;
        }
      }
      blank(i, j);
      i = j;
    } else if (c === '$' && !(i > 0 && /[A-Za-z0-9_]/.test(sql[i - 1] ?? ''))) {
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i))?.[0];
      if (tag) {
        const end = sql.indexOf(tag, i + tag.length);
        const stop = end === -1 ? n : end + tag.length;
        blank(i, stop);
        i = stop;
      } else {
        i += 1;
      }
    } else {
      i += 1;
    }
  }
  return out.join('');
}

export interface SqlStatement {
  /** Masked statement text, whitespace-collapsed and trimmed. */
  text: string;
  /** 1-based line of the statement's first character in the original file. */
  line: number;
}

/** Splits masked SQL on semicolons into non-empty statements with their starting line. */
export function splitStatements(masked: string): SqlStatement[] {
  const statements: SqlStatement[] = [];
  let start = 0;
  for (let i = 0; i <= masked.length; i += 1) {
    if (i === masked.length || masked[i] === ';') {
      const raw = masked.slice(start, i);
      const offset = raw.search(/\S/);
      if (offset !== -1) {
        const line = masked.slice(0, start + offset).split('\n').length;
        statements.push({ text: raw.trim().replace(/\s+/g, ' '), line });
      }
      start = i + 1;
    }
  }
  return statements;
}
