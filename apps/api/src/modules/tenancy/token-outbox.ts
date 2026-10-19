import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * DEVELOPMENT delivery of one-time activation and reset links (R-011). Each message is written
 * to a git-ignored folder on this Mac (files readable by the local user only), for the local
 * operator to pass on. Tokens are NEVER returned to administrators or logged. This is not a
 * verified delivery channel: production needs an approved provider (configuration refuses
 * production while this outbox is in use).
 */
export interface TokenMessage {
  to: string;
  purpose: 'activation' | 'password_reset';
  token: string;
  expiresAt: Date;
}

export interface TokenDelivery {
  deliver(message: TokenMessage): Promise<void>;
}

export class DevelopmentOutbox implements TokenDelivery {
  constructor(private readonly dir: string) {}

  async deliver(m: TokenMessage): Promise<void> {
    await fs.promises.mkdir(this.dir, { recursive: true, mode: 0o700 });
    const file = path.join(
      this.dir,
      `${Date.now()}-${m.purpose}-${randomBytes(4).toString('hex')}.json`,
    );
    const body = {
      to: m.to,
      purpose: m.purpose,
      expiresAt: m.expiresAt.toISOString(),
      // The token is in the URL fragment (#), which browsers never send to servers.
      link: `http://localhost:3000/account/set-password#token=${m.token}`,
      token: m.token,
      note: 'DEVELOPMENT OUTBOX (R-011): not a verified delivery channel. Fictional accounts only.',
    };
    await fs.promises.writeFile(file, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
  }
}
