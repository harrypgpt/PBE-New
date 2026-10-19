'use client';

import { accountPasswordRoute, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@pbe/contracts';
import { useState, type FormEvent } from 'react';
import { callRoute } from '../api-client/client';
import { ErrorSummary, type FieldError } from '../ui/ErrorSummary';
import { ErrorState, Notice } from '../ui/feedback';
import { Button, RequiredFieldsNote, TextInput } from '../ui/forms';
import { requestIdOf, signInErrorMessage } from './messages';

/** Change your own password. The server checks the full policy and ends all other sessions. */
export function PasswordChangeForm() {
  const [errors, setErrors] = useState<readonly FieldError[]>([]);
  const [failure, setFailure] = useState<{
    message: string;
    requestId?: string | undefined;
  } | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const current = String(data.get('current-password') ?? '');
    const next = String(data.get('new-password') ?? '');
    const repeat = String(data.get('repeat-password') ?? '');
    const found: FieldError[] = [];
    if (current === '')
      found.push({ fieldId: 'current-password', message: 'Enter your current password' });
    const length = [...next.normalize('NFKC')].length;
    if (length < PASSWORD_MIN_LENGTH || length > PASSWORD_MAX_LENGTH) {
      found.push({
        fieldId: 'new-password',
        message: `Use ${PASSWORD_MIN_LENGTH} to ${PASSWORD_MAX_LENGTH} characters`,
      });
    }
    if (repeat !== next)
      found.push({ fieldId: 'repeat-password', message: 'The new passwords do not match' });
    setErrors(found);
    setFailure(null);
    setDone(false);
    if (found.length > 0) return;
    setBusy(true);
    try {
      await callRoute(accountPasswordRoute, {
        body: { currentPassword: current, newPassword: next },
      });
      form.reset();
      setDone(true);
    } catch (error) {
      setFailure({ message: signInErrorMessage(error), requestId: requestIdOf(error) });
    } finally {
      setBusy(false);
    }
  }

  const errorFor = (id: string) => errors.find((e) => e.fieldId === id)?.message;
  return (
    <form noValidate onSubmit={onSubmit} aria-label="Change password">
      <ErrorSummary errors={errors} />
      {failure ? (
        <ErrorState
          title="Password not changed"
          message={failure.message}
          requestId={failure.requestId}
        />
      ) : null}
      {done ? (
        <Notice tone="success" title="Password changed">
          <p>You were signed out everywhere else. This browser stays signed in.</p>
        </Notice>
      ) : null}
      <RequiredFieldsNote />
      <TextInput
        id="current-password"
        label="Current password"
        type="password"
        autoComplete="current-password"
        required
        maxLength={1024}
        error={errorFor('current-password')}
      />
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
        Change password
      </Button>
    </form>
  );
}
