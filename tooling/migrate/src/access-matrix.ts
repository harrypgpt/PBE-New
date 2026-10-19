import { randomBytes } from 'node:crypto';
import pg from 'pg';

/**
 * Connection matrix for the backup login (STAGE-07A-BACKUP-REVIEW.md §16). Makes REAL connection
 * attempts over every transport, to every database, and as replication connections, and checks:
 *  - "allowed" cells connect, and the server used SCRAM-SHA-256 (system_user);
 *  - "rejected" cells are refused BY pg_hba.conf (a reject rule or no matching rule), not merely
 *    by a missing database privilege, so the connection rule is proven to be the control.
 *    Exception: a LOGICAL replication connection is matched in pg_hba.conf by its database name,
 *    so to pbe_dev/pbe_test it passes the allow line; it must then be refused because the role
 *    has no REPLICATION attribute.
 * Nothing is written; an allowed connection runs only "SELECT system_user".
 */

export type Transport = 'tcp-ipv4' | 'tcp-ipv6' | `socket ${string}`;

export interface AccessCell {
  transport: Transport;
  database: string;
  replication: 'none' | 'physical' | 'logical';
  expected: 'allowed' | 'rejected';
  observed: 'allowed' | 'rejected';
  detail: string;
  ok: boolean;
}

export interface AccessMatrixOptions {
  port: number;
  /** Unix-socket directories the server listens on (e.g. /tmp). */
  socketDirs: readonly string[];
  user: string;
  password: string;
  /** Databases the login may reach over TCP from this computer. */
  allowed: readonly string[];
  /** Further existing databases that must be refused (postgres, template0/1 are always tried). */
  otherDatabases?: readonly string[];
  tcp?: { ipv4: boolean; ipv6: boolean };
}

const ROLE_REFUSAL = /REPLICATION|permission denied to start WAL sender/i;
const HBA_REFUSAL =
  /pg_hba\.conf rejects (connection|replication connection)|no pg_hba\.conf entry/;

async function attempt(
  host: string,
  options: AccessMatrixOptions,
  database: string,
  replication: AccessCell['replication'],
): Promise<{ observed: AccessCell['observed']; detail: string; scram: boolean; byHba: boolean }> {
  const client = new pg.Client({
    host,
    port: options.port,
    user: options.user,
    password: options.password,
    database,
    connectionTimeoutMillis: 5000,
    application_name: 'pbe-access-matrix',
    ...(replication === 'none'
      ? {}
      : { replication: replication === 'logical' ? 'database' : true }),
  } as pg.ClientConfig);
  client.on('error', () => undefined);
  try {
    await client.connect();
  } catch (err) {
    const message = (err as Error).message;
    return {
      observed: 'rejected',
      detail: message,
      scram: false,
      byHba: HBA_REFUSAL.test(message),
    };
  }
  try {
    if (replication !== 'none') {
      return {
        observed: 'allowed',
        detail: 'replication connection accepted',
        scram: false,
        byHba: false,
      };
    }
    const r = await client.query<{ s: string | null }>('SELECT system_user AS s');
    const method = String(r.rows[0]?.s ?? '').split(':')[0] ?? '';
    return {
      observed: 'allowed',
      detail: `authenticated with ${method}`,
      scram: method === 'scram-sha-256',
      byHba: false,
    };
  } finally {
    await client.end().catch(() => undefined);
  }
}

export async function backupAccessMatrix(options: AccessMatrixOptions): Promise<AccessCell[]> {
  const tcp = options.tcp ?? { ipv4: true, ipv6: true };
  const transports: Array<[Transport, string]> = [
    ...(tcp.ipv4 ? [['tcp-ipv4', '127.0.0.1'] as [Transport, string]] : []),
    ...(tcp.ipv6 ? [['tcp-ipv6', '::1'] as [Transport, string]] : []),
    ...options.socketDirs.map((d) => [`socket ${d}`, d] as [Transport, string]),
  ];
  const missing = `pbe_no_such_db_${randomBytes(4).toString('hex')}`;
  const databases = [
    ...options.allowed,
    'postgres',
    'template1',
    'template0',
    ...(options.otherDatabases ?? []),
    missing,
  ];
  const cells: AccessCell[] = [];
  for (const [transport, host] of transports) {
    const isTcp = !transport.startsWith('socket');
    const tries: Array<[string, AccessCell['replication']]> = [
      ...databases.map((d) => [d, 'none'] as [string, AccessCell['replication']]),
      ['replication', 'physical'],
      ...options.allowed.map((d) => [d, 'logical'] as [string, AccessCell['replication']]),
    ];
    for (const [database, replication] of tries) {
      const expected =
        isTcp && replication === 'none' && options.allowed.includes(database)
          ? 'allowed'
          : 'rejected';
      const r = await attempt(host, options, database, replication);
      const refusedProperly = r.byHba || (replication === 'logical' && ROLE_REFUSAL.test(r.detail));
      const ok = r.observed === expected && (expected === 'allowed' ? r.scram : refusedProperly);
      cells.push({
        transport,
        database: database === missing ? '(a database that does not exist)' : database,
        replication,
        expected,
        observed: r.observed,
        detail: r.detail,
        ok,
      });
    }
  }
  return cells;
}

export function formatAccessMatrix(cells: readonly AccessCell[]): string {
  return cells
    .map(
      (c) =>
        `${c.ok ? 'PASS' : 'FAIL'}  ${c.transport.padEnd(18)} ${(c.replication === 'none' ? c.database : `${c.database} [${c.replication} replication]`).padEnd(48)} expected ${c.expected.padEnd(8)} observed ${c.observed.padEnd(8)} ${c.detail}`,
    )
    .join('\n');
}
