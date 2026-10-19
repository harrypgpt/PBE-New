'use client';

import { loginRoute, type SignInNext } from '@pbe/contracts';
import { useState, type FormEvent } from 'react';
import { callRoute } from '../api-client/client';
import { ErrorSummary, type FieldError } from '../ui/ErrorSummary';
import { ErrorState } from '../ui/feedback';
import { Button, RequiredFieldsNote, TextInput } from '../ui/forms';
import { requestIdOf, signInErrorMessage } from './messages';

/** Where each sign-in step leads. */
export const NEXT_PAGE: Record<SignInNext, string> = {
  done: '/',
  mfa: '/login/mfa',
  enrol: '/account/mfa',
};

export function LoginForm({
  navigate = (url: string) => window.location.assign(url),
}: {
  readonly navigate?: (url: string) => void;
}) {
  const [errors, setErrors] = useState<readonly FieldError[]>([]);
  const [failure, setFailure] = useState<{
    message: string;
    requestId?: string | undefined;
  } | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const email = String(data.get('email') ?? '').trim();
    const password = String(data.get('password') ?? '');
    const found: FieldError[] = [];
    if (email === '') found.push({ fieldId: 'email', message: 'Enter your email address' });
    if (password === '') found.push({ fieldId: 'password', message: 'Enter your password' });
    setErrors(found);
    setFailure(null);
    if (found.length > 0) return;
    setBusy(true);
    try {
      const result = await callRoute(loginRoute, { body: { email, password } });
      navigate(NEXT_PAGE[result.data.next]);
    } catch (error) {
      setFailure({ message: signInErrorMessage(error), requestId: requestIdOf(error) });
      setBusy(false);
    }
  }

  const errorFor = (id: string) => errors.find((e) => e.fieldId === id)?.message;
  return (
    <form noValidate onSubmit={onSubmit} aria-label="Sign in">
      <ErrorSummary errors={errors} />
      {failure ? (
        <ErrorState
          title="Sign-in failed"
          message={failure.message}
          requestId={failure.requestId}
        />
      ) : null}
      <RequiredFieldsNote />
      <TextInput
        id="email"
        label="Email address"
        type="email"
        inputMode="email"
        autoComplete="username"
        required
        maxLength={254}
        error={errorFor('email')}
      />
      <TextInput
        id="password"
        label="Password"
        type="password"
        autoComplete="current-password"
        required
        maxLength={1024}
        error={errorFor('password')}
      />
      <Button type="submit" disabled={busy}>
        {busy ? 'Signing in…' : 'Sign in'}
      </Button>
    </form>
  );
}
