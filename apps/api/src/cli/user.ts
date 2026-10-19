import readline from 'node:readline';
import { EmailSchema } from '@pbe/contracts';
import { hashPassword } from '../modules/auth/password-hash';
import { Blocklist, passwordProblem } from '../modules/auth/password-policy';
import {
  assertSafeRuntimeRole,
  createDatabase,
  createOperatorDatabase,
  tenancy,
  identity,
  runtimeConnectionFromEnv,
  type Database,
  type SessionEndReason,
} from '../modules/db';

/**
 * Operator commands (STAGE-06-PLAN.md §3): `npm run user -- <command> --email <address> …`
 *   create --email E --name "Display name"   create a user (password typed twice, hidden)
 *   reset-password --email E                 set a new password (hidden); ends ALL their sessions
 *   require-mfa --email E [--off]            require (or stop requiring) an authenticator app
 *   reset-mfa --email E                      remove their authenticator and recovery codes
 *   grant-platform-role --email E            make E a Super Admin (platform_owner; Stage 7A, ADR-029):
 *   revoke-platform-role --email E           requires MFA, ends E's sessions, audited. Uses the
 *                                            OPERATOR connection (pbe_owner via the migration
 *                                            login); the API can never grant platform roles.
 * Passwords are read only from a hidden terminal prompt (or, for automated tests, from piped
 * standard input), never from arguments or files, and are never printed. Connects as pbe_app
 * through the data-access layer; the database is PBE_PG_DEV_DATABASE (default pbe_dev).
 */

type Command =
  | 'create'
  | 'reset-password'
  | 'require-mfa'
  | 'reset-mfa'
  | 'grant-platform-role'
  | 'revoke-platform-role';
const COMMANDS: readonly Command[] = [
  'create',
  'reset-password',
  'require-mfa',
  'reset-mfa',
  'grant-platform-role',
  'revoke-platform-role',
];

class UsageError extends Error {}

function parseArgs(argv: string[]): { command: Command; flags: Map<string, string | true> } {
  const [command, ...rest] = argv;
  if (!COMMANDS.includes(command as Command)) {
    throw new UsageError(`Unknown command. Use one of: ${COMMANDS.join(', ')}.`);
  }
  const flags = new Map<string, string | true>();
  for (let i = 0; i < rest.length; i += 1) {
    const key = rest[i]!;
    if (!key.startsWith('--')) throw new UsageError(`Unexpected argument "${key}".`);
    const next = rest[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags.set(key.slice(2), next);
      i += 1;
    } else flags.set(key.slice(2), true);
  }
  if (flags.has('password')) {
    throw new UsageError('Passwords are never accepted as arguments; you will be asked for it.');
  }
  return { command: command as Command, flags };
}

/** Reads lines from piped input (tests), or hidden keystrokes from a terminal. */
class Prompter {
  private lines: string[] = [];
  private waiting: ((line: string | null) => void) | null = null;
  private ended = false;

  constructor() {
    if (!process.stdin.isTTY) {
      const rl = readline.createInterface({ input: process.stdin, terminal: false });
      rl.on('line', (l) => this.push(l));
      rl.on('close', () => {
        this.ended = true;
        this.waiting?.(null);
      });
    }
  }

  private push(line: string) {
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = null;
      w(line);
    } else this.lines.push(line);
  }

  async hidden(question: string): Promise<string> {
    process.stdout.write(question);
    if (!process.stdin.isTTY) {
      const line =
        this.lines.shift() ??
        (this.ended ? null : await new Promise<string | null>((r) => (this.waiting = r)));
      process.stdout.write('\n');
      if (line === null) throw new UsageError('No password supplied.');
      return line;
    }
    return new Promise((resolve, reject) => {
      let value = '';
      const stdin = process.stdin;
      stdin.setRawMode(true);
      stdin.resume();
      stdin.setEncoding('utf8');
      const onData = (chunk: string) => {
        for (const ch of chunk) {
          if (ch === '\r' || ch === '\n') {
            cleanup();
            process.stdout.write('\n');
            resolve(value);
            return;
          }
          if (ch === '\u0003') {
            cleanup();
            process.stdout.write('\n');
            reject(new UsageError('Cancelled.'));
            return;
          }
          if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
          else value += ch;
        }
      };
      const cleanup = () => {
        stdin.off('data', onData);
        stdin.setRawMode(false);
        stdin.pause();
      };
      stdin.on('data', onData);
    });
  }
}

async function askNewPassword(
  prompter: Prompter,
  email: string,
  blocklist: Blocklist,
): Promise<string> {
  const first = await prompter.hidden('New password (hidden, 15–128 characters): ');
  const problem = passwordProblem(first, { email }, blocklist);
  if (problem) throw new UsageError(`Password not accepted: ${problem}`);
  const second = await prompter.hidden('Type it again: ');
  if (first !== second)
    throw new UsageError('The two passwords did not match. Nothing was changed.');
  return first;
}

function emailFlag(flags: Map<string, string | true>): string {
  const value = flags.get('email');
  const parsed = EmailSchema.safeParse(typeof value === 'string' ? value : '');
  if (!parsed.success) throw new UsageError('Give --email with a valid address.');
  return parsed.data;
}

async function userIdFor(db: Database, email: string): Promise<string> {
  const id = await identity.userIdByEmail(db, email);
  if (!id) throw new UsageError('No user with that email address. Nothing was changed.');
  return id;
}

async function endSessions(
  db: Database,
  userId: string,
  reason: SessionEndReason,
): Promise<number> {
  return identity.sessionEndAll(db, userId, reason, null);
}

async function run(argv: string[]): Promise<void> {
  const { command, flags } = parseArgs(argv);
  const email = emailFlag(flags);
  const connection = runtimeConnectionFromEnv(process.env);
  const db = createDatabase(connection, { maxConnections: 2 });
  const prompter = new Prompter();
  try {
    await assertSafeRuntimeRole(db);
    console.log(`Database: ${connection.database} (as ${connection.user})`);
    const blocklist = Blocklist.load();
    const event = (
      eventType: string,
      userId: string,
      detail: Record<string, string | number | boolean> = {},
    ) =>
      identity.recordSecurityEvent(db, {
        eventType,
        outcome: 'success',
        userId,
        actor: 'operator',
        detail,
      });

    if (command === 'create') {
      const name = flags.get('name');
      if (typeof name !== 'string' || name.trim().length === 0) {
        throw new UsageError('Give --name "Display name".');
      }
      if (await identity.userIdByEmail(db, email)) {
        throw new UsageError('A user with that email address already exists. Nothing was changed.');
      }
      const password = await askNewPassword(prompter, email, blocklist);
      const userId = await identity.createUser(db, email, name.trim());
      await identity.credentialSet(db, userId, await hashPassword(password));
      await event('user_created', userId);
      console.log(`Created user ${userId}.`);
    } else if (command === 'reset-password') {
      const userId = await userIdFor(db, email);
      const password = await askNewPassword(prompter, email, blocklist);
      await identity.credentialSet(db, userId, await hashPassword(password));
      const ended = await endSessions(db, userId, 'password_reset');
      await event('password_reset', userId, { sessionsEnded: ended });
      console.log(`Password reset. ${ended} session(s) ended.`);
    } else if (command === 'require-mfa') {
      const userId = await userIdFor(db, email);
      const required = flags.get('off') !== true;
      await identity.setMfaRequired(db, userId, required);
      const ended = required ? await endSessions(db, userId, 'policy_changed') : 0;
      await event('mfa_requirement_changed', userId, { required, sessionsEnded: ended });
      console.log(
        `Authenticator app ${required ? 'now required' : 'no longer required'}. ${ended} session(s) ended.`,
      );
    } else if (command === 'grant-platform-role' || command === 'revoke-platform-role') {
      const userId = await userIdFor(db, email);
      const grant = command === 'grant-platform-role';
      const operator = createOperatorDatabase(process.env, connection.database);
      try {
        // Audited inside the database function (business audit trail and security log).
        const changed = await tenancy.operatorSetPlatformRole(
          operator,
          userId,
          'platform_owner',
          grant,
        );
        const ended = await endSessions(db, userId, 'policy_changed');
        console.log(
          `Super Admin role ${grant ? 'granted' : 'revoked'}${changed ? '' : ' (no change)'}. ${ended} session(s) ended.${grant ? ' An authenticator app is required at the next sign-in.' : ''}`,
        );
      } finally {
        await operator.destroy();
      }
    } else {
      const userId = await userIdFor(db, email);
      await identity.mfaReset(db, userId);
      const ended = await endSessions(db, userId, 'mfa_reset');
      await event('mfa_reset', userId, { sessionsEnded: ended });
      console.log(`Authenticator app and recovery codes removed. ${ended} session(s) ended.`);
    }
  } finally {
    await db.destroy();
  }
}

run(process.argv.slice(2)).then(
  () => process.exit(0),
  (err: unknown) => {
    // Plain messages only: never a stack, SQL or value that could contain a secret.
    console.error(
      err instanceof UsageError
        ? err.message
        : 'The command failed. Nothing secret was printed; check the database connection.',
    );
    process.exit(1);
  },
);
