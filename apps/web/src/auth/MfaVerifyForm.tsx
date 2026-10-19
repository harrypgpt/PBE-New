'use client';

import { mfaVerifyRoute } from '@pbe/contracts';
import { useState, type FormEvent } from 'react';
import { callRoute } from '../api-client/client';
import { ErrorSummary, type FieldError } from '../ui/ErrorSummary';
import { ErrorState } from '../ui/feedback';
import { Button, TextInput } from '../ui/forms';
import { requestIdOf, signInErrorMessage } from './messages';

/** Second sign-in step: a code from the authenticator app, or a one-time recovery code. */
export function MfaVerifyForm({
  navigate = (url: string) => window.location.assign(url),
}: {
  readonly navigate?: (url: string) => void;
}) {
  const [useRecovery, setUseRecovery] = useState(false);
  const [errors, setErrors] = useState<readonly FieldError[]>([]);
  const [failure, setFailure] = useState<{
    message: string;
    requestId?: string | undefined;
  } | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = String(new FormData(event.currentTarget).get('mfa-code') ?? '').trim();
    const valid = useRecovery
      ? /^[A-Za-z0-9]{5}-?[A-Za-z0-9]{5}$/.test(value)
      : /^\d{6}$/.test(value);
    const message = useRecovery
      ? 'Enter a recovery code like ABCDE-23456'
      : 'Enter the 6-digit code';
    setErrors(valid ? [] : [{ fieldId: 'mfa-code', message }]);
    setFailure(null);
    if (!valid) return;
    setBusy(true);
    try {
      await callRoute(mfaVerifyRoute, {
        body: useRecovery ? { recoveryCode: value } : { code: value },
      });
      navigate('/');
    } catch (error) {
      setFailure({ message: signInErrorMessage(error), requestId: requestIdOf(error) });
      setBusy(false);
    }
  }

  return (
    <form noValidate onSubmit={onSubmit} aria-label="Verify sign-in">
      <ErrorSummary errors={errors} />
      {failure ? (
        <ErrorState
          title="Code not accepted"
          message={failure.message}
          requestId={failure.requestId}
        />
      ) : null}
      <TextInput
        key={useRecovery ? 'recovery' : 'totp'}
        id="mfa-code"
        label={useRecovery ? 'Recovery code' : 'Code from your authenticator app'}
        hint={useRecovery ? 'Each recovery code works once.' : 'Six digits, for example 123456.'}
        inputMode={useRecovery ? 'text' : 'numeric'}
        autoComplete="one-time-code"
        maxLength={useRecovery ? 11 : 6}
        required
        error={errors[0]?.message}
      />
      <p>
        <Button type="submit" disabled={busy}>
          Verify
        </Button>{' '}
        <Button
          variant="secondary"
          onClick={() => {
            setUseRecovery(!useRecovery);
            setErrors([]);
            setFailure(null);
          }}
        >
          {useRecovery ? 'Use the authenticator app instead' : 'Use a recovery code instead'}
        </Button>
      </p>
    </form>
  );
}
