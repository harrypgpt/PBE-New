'use client';

import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, tokenPasswordRoute } from '@pbe/contracts';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { callRoute } from '../api-client/client';
import { ErrorSummary, type FieldError } from '../ui/ErrorSummary';
import { ErrorState, Notice } from '../ui/feedback';
import { Button, RequiredFieldsNote, TextInput } from '../ui/forms';
import { requestIdOf, signInErrorMessage } from './messages';

const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** Reads "#token=…" and removes it from the address bar and history straight away. */
export function takeTokenFromLocation(
  location: Pick<Location, 'hash' | 'pathname' | 'search'>,
  replace: (url: string) => void,
): string | null {
  const match = /(?:^#|&)token=([^&]*)/.exec(location.hash);
  if (location.hash !== '') replace(`${location.pathname}${location.search}`);
  const token = match?.[1] ?? null;
  return token !== null && TOKEN.test(token) ? token : null;
}

/**
 * Set your own password with a one-time activation or reset link (ADR-029). The token travels
 * only in the URL fragment (never sent to a server by the browser) and is removed from the
 * address bar at once. The person chooses the password; administrators never see or set it.
 */
export function SetPasswordForm() {
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [errors, setErrors] = useState<readonly FieldError[]>([]);
  const [failure, setFailure] = useState<{
    message: string;
    requestId?: string | undefined;
  } | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  // Read the link ONCE per page. React runs start-up effects twice in development (Strict Mode);
  // the second run would find the address already cleaned and lose the token.
  const taken = useRef<{ token: string | null } | null>(null);
  useEffect(() => {
    taken.current ??= {
      token: takeTokenFromLocation(window.location, (url) =>
        window.history.replaceState(null, '', url),
      ),
    };
    setToken(taken.current.token);
  }, []);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const next = String(data.get('new-password') ?? '');
    const repeat = String(data.get('repeat-password') ?? '');
    const found: FieldError[] = [];
    const length = [...next.normalize('NFKC')].length;
    if (length < PASSWORD_MIN_LENGTH || length > PASSWORD_MAX_LENGTH)
      found.push({
        fieldId: 'new-password',
        message: `Use ${PASSWORD_MIN_LENGTH} to ${PASSWORD_MAX_LENGTH} characters`,
      });
    if (repeat !== next)
      found.push({ fieldId: 'repeat-password', message: 'The passwords do not match' });
    setErrors(found);
    setFailure(null);
    if (found.length > 0) return;
    setBusy(true);
    try {
      await callRoute(tokenPasswordRoute, { body: { token, newPassword: next } });
      form.reset();
      setDone(true);
    } catch (error) {
      setFailure({ message: signInErrorMessage(error), requestId: requestIdOf(error) });
    } finally {
      setBusy(false);
    }
  }

  if (token === undefined) return null; // reading the link
  if (done) {
    return (
      <Notice tone="success" title="Password set">
        <p>
          You can now <a href="/login">sign in</a> with your email address and new password.
        </p>
      </Notice>
    );
  }
  if (token === null) {
    return (
      <ErrorState
        title="This link cannot be used"
        message="The link is incomplete. Open the full link you received, or ask your organisation's administrator for a new one."
      />
    );
  }
  const errorFor = (id: string) => errors.find((e) => e.fieldId === id)?.message;
  return (
    <form noValidate onSubmit={onSubmit} aria-label="Set your password">
      <ErrorSummary errors={errors} />
      {failure ? (
        <ErrorState
          title="Password not set"
          message={failure.message}
          requestId={failure.requestId}
        />
      ) : null}
      <p>
        This link works once and expires after a few hours. If it has expired, ask your
        organisation&apos;s administrator for a new one.
      </p>
      <RequiredFieldsNote />
      <TextInput
        id="new-password"
        label="New password"
        type="password"
        autoComplete="new-password"
        required
        maxLength={4 * PASSWORD_MAX_LENGTH}
        hint={`${PASSWORD_MIN_LENGTH} to ${PASSWORD_MAX_LENGTH} characters. A passphrase of several words works well. Common or leaked passwords are refused.`}
        error={errorFor('new-password')}
      />
      <TextInput
        id="repeat-password"
        label="Repeat the new password"
        type="password"
        autoComplete="new-password"
        required
        maxLength={4 * PASSWORD_MAX_LENGTH}
        error={errorFor('repeat-password')}
      />
      <Button type="submit" disabled={busy}>
        Set password
      </Button>
    </form>
  );
}
