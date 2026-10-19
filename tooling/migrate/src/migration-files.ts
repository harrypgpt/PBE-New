import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { maskSql, splitStatements } from './sql-lexer';

export type Phase = 'expand' | 'migrate' | 'contract';

export interface MigrationFile {
  version: number;
  /** Descriptive part of the file name, e.g. "schema_skeleton". */
  name: string;
  fileName: string;
  sql: string;
  /** SHA-256 (hex) of the exact file bytes. */
  checksum: string;
  phase: Phase;
  transactional: boolean;
}

export interface LoadResult {
  files: MigrationFile[];
  problems: string[];
}

export const FILE_NAME = /^(\d{4})_([a-z0-9]+(?:_[a-z0-9]+)*)\.sql$/;
const IGNORED_FILES = new Set(['README.md', '.gitkeep']);
const PHASES: readonly Phase[] = ['expand', 'migrate', 'contract'];

/** Statements no migration may contain: they break per-file atomicity or belong to the reviewed bootstrap. */
const FORBIDDEN: ReadonlyArray<[RegExp, string]> = [
  [
    /^(BEGIN|START TRANSACTION|COMMIT|END|ROLLBACK|ABORT|SAVEPOINT|RELEASE|PREPARE TRANSACTION|COMMIT PREPARED|ROLLBACK PREPARED|SET TRANSACTION|SET SESSION CHARACTERISTICS)\b/i,
    'transaction control is managed by the runner',
  ],
  [
    /^(CREATE|ALTER|DROP) (ROLE|USER|GROUP)\b/i,
    'roles are managed only by the reviewed bootstrap SQL',
  ],
  [/^(CREATE|ALTER|DROP) DATABASE\b/i, 'databases are managed only by the reviewed bootstrap SQL'],
  [/^ALTER SYSTEM\b/i, 'server configuration must not be changed by migrations'],
  [/^(SET|RESET) (ROLE|SESSION AUTHORIZATION)\b/i, 'changing role would change object ownership'],
  [/^SET (?!LOCAL\b)/i, 'session-level SET leaks into later migrations; use SET LOCAL'],
  [/^RESET\b/i, 'RESET changes session state; use SET LOCAL instead'],
  [/^\\/, 'psql meta-commands are not supported'],
];

/** Destructive or backward-incompatible statements: allowed only in contract-phase files. */
const CONTRACT_ONLY: ReadonlyArray<[RegExp, string]> = [
  [/^DROP\b/i, 'DROP'],
  [/^TRUNCATE\b/i, 'TRUNCATE'],
  [/^DELETE\b/i, 'DELETE'],
  [/^ALTER\b.*\bDROP\b(?! NOT NULL)/i, 'ALTER … DROP'],
  [/^ALTER\b.*\bRENAME\b/i, 'ALTER … RENAME'],
  [/^ALTER TABLE\b.*\bALTER (COLUMN )?\S+ (SET DATA )?TYPE\b/i, 'column type change'],
];

export function sha256Hex(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Parses and safety-checks one migration file. Returns the file (if usable) and any problems. */
export function parseMigration(
  fileName: string,
  content: Buffer,
  options: { ledgerSchema: string },
): { file: MigrationFile | null; problems: string[] } {
  const problems: string[] = [];
  const match = FILE_NAME.exec(fileName);
  if (!match) {
    return {
      file: null,
      problems: [
        `${fileName}: name must look like 0001_short_description.sql (lower case, underscores)`,
      ],
    };
  }
  const version = Number(match[1]);
  const sql = content.toString('utf8');
  const say = (msg: string): void => {
    problems.push(`${fileName}: ${msg}`);
  };

  if (version < 1) say('version numbers start at 0001');

  // Directives: "-- pbe:phase expand|migrate|contract" (required) and "-- pbe:no-transaction".
  let phase: Phase | null = null;
  let transactional = true;
  for (const line of sql.split(/\r?\n/)) {
    const d = /^\s*--\s*pbe:(\S+)\s*(.*?)\s*$/.exec(line);
    if (!d) continue;
    const [, key, value] = d;
    if (key === 'phase') {
      if (phase) say('declares its phase more than once');
      if (!PHASES.includes(value as Phase))
        say(`unknown phase "${value}" (use expand, migrate or contract)`);
      else phase = value as Phase;
    } else if (key === 'no-transaction' && value === '') {
      transactional = false;
    } else {
      say(`unknown directive "pbe:${key}${value ? ` ${value}` : ''}"`);
    }
  }
  if (!phase) say('missing "-- pbe:phase expand|migrate|contract" header');

  const statements = splitStatements(maskSql(sql));
  if (statements.length === 0) say('contains no SQL statements');

  const ledgerRef = new RegExp(`\\b${options.ledgerSchema}\\b`, 'i');
  for (const st of statements) {
    for (const [re, why] of FORBIDDEN) {
      if (re.test(st.text)) say(`line ${st.line}: statement not allowed (${why})`);
    }
    if (phase !== 'contract') {
      for (const [re, label] of CONTRACT_ONLY) {
        if (re.test(st.text)) {
          say(
            `line ${st.line}: ${label} is destructive and allowed only in a contract-phase migration`,
          );
        }
      }
    }
    if (ledgerRef.test(st.text) && !/^(GRANT|REVOKE)\b/i.test(st.text)) {
      say(
        `line ${st.line}: migrations must not modify the migration ledger schema "${options.ledgerSchema}"`,
      );
    }
  }

  if (!transactional) {
    if (statements.length !== 1)
      say('a no-transaction migration must contain exactly one statement');
    if (statements.some((st) => !/\bIF (NOT )?EXISTS\b/i.test(st.text))) {
      say('a no-transaction statement must be re-runnable (use IF NOT EXISTS / IF EXISTS)');
    }
  }

  if (problems.length > 0 || !phase) return { file: null, problems };
  return {
    file: {
      version,
      name: match[2] ?? '',
      fileName,
      sql,
      checksum: sha256Hex(content),
      phase,
      transactional,
    },
    problems,
  };
}

/** Loads every migration in a folder and checks names, numbering and contents. */
export function loadMigrations(dir: string, options: { ledgerSchema: string }): LoadResult {
  if (!fs.existsSync(dir)) return { files: [], problems: [`migrations folder not found: ${dir}`] };
  const problems: string[] = [];
  const files: MigrationFile[] = [];
  const seen = new Map<number, string>();
  for (const entry of fs
    .readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))) {
    if (IGNORED_FILES.has(entry.name)) continue;
    if (!entry.isFile()) {
      problems.push(`${entry.name}: unexpected item in migrations folder`);
      continue;
    }
    const version = Number(FILE_NAME.exec(entry.name)?.[1] ?? NaN);
    if (!Number.isNaN(version)) {
      const other = seen.get(version);
      if (other) problems.push(`${entry.name}: duplicate version ${version} (also ${other})`);
      seen.set(version, entry.name);
    }
    const parsed = parseMigration(entry.name, fs.readFileSync(path.join(dir, entry.name)), options);
    problems.push(...parsed.problems);
    if (parsed.file) files.push(parsed.file);
  }
  const versions = [...seen.keys()].sort((a, b) => a - b);
  versions.forEach((v, i) => {
    if (v !== i + 1) problems.push(`numbering gap: expected version ${i + 1} but found ${v}`);
  });
  files.sort((a, b) => a.version - b.version);
  return { files, problems: [...new Set(problems)] };
}
