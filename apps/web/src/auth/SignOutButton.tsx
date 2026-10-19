'use client';

import { logoutRoute } from '@pbe/contracts';
import { useState } from 'react';
import { callRoute } from '../api-client/client';
import { Button } from '../ui/forms';

/** Ends the session on the server, then returns to the sign-in page. */
export function SignOutButton() {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant="secondary"
      disabled={busy}
      onClick={() => {
        setBusy(true);
        // Whatever the answer, leave the signed-in pages; the server has ended the session or
        // there was none.
        callRoute(logoutRoute)
          .catch(() => undefined)
          .finally(() => window.location.assign('/login'));
      }}
    >
      Sign out
    </Button>
  );
}
