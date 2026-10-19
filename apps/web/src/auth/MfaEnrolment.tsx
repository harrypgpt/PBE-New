'use client';

import { accountMfaConfirmRoute, accountMfaEnrolRoute } from '@pbe/contracts';
import { useState, type FormEvent } from 'react';
import { callRoute } from '../api-client/client';
import { ErrorSummary, type FieldError } from '../ui/ErrorSummary';
import { ErrorState, Notice } from '../ui/feedback';
import { Button, TextInput } from '../ui/forms';
import { StepProgress } from '../ui/progress';
import { requestIdOf, signInErrorMessage } from './messages';
import styles from './auth.module.css';

/**
 * Accepts only the plain SVG the QR library produces: no scripts, event handlers, links or
 * foreign objects. Anything else is not shown (defence in depth; the CSP also blocks scripts).
 */
export function isSafeQrSvg(svg: string): boolean {
  return (
    /^<svg[\s>]/.test(svg) &&
    /<\/svg>\s*$/.test(svg) &&
    !/<script|<foreignObject|<iframe|<image|\son[a-z]+\s*=|href\s*=|javascript:|style\s*=/i.test(
      svg,
    )
  );
}

type Step =
  | { kind: 'start' }
  | { kind: 'scan'; manualKey: string; qrSvg: string }
  | { kind: 'done'; codes: string[] };

/** Authenticator-app set-up: start → scan or type the key → confirm with a code → recovery codes. */
export function MfaEnrolment({
  navigate = (url: string) => window.location.assign(url),
}: {
  readonly navigate?: (url: string) => void;
}) {
  const [step, setStep] = useState<Step>({ kind: 'start' });
  const [errors, setErrors] = useState<readonly FieldError[]>([]);
  const [failure, setFailure] = useState<{
    message: string;
    requestId?: string | undefined;
  } | null>(null);
  const [busy, setBusy] = useState(false);

  async function start() {
    setBusy(true);
    setFailure(null);
    try {
      const r = await callRoute(accountMfaEnrolRoute);
      setStep({ kind: 'scan', manualKey: r.data.manualKey, qrSvg: r.data.qrSvg });
    } catch (error) {
      setFailure({ message: signInErrorMessage(error), requestId: requestIdOf(error) });
    } finally {
      setBusy(false);
    }
  }

  async function confirm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = String(new FormData(event.currentTarget).get('enrol-code') ?? '').trim();
    const valid = /^\d{6}$/.test(value);
    setErrors(
      valid ? [] : [{ fieldId: 'enrol-code', message: 'Enter the 6-digit code from the app' }],
    );
    setFailure(null);
    if (!valid) return;
    setBusy(true);
    try {
      const r = await callRoute(accountMfaConfirmRoute, { body: { code: value } });
      setStep({ kind: 'done', codes: r.data.recoveryCodes });
    } catch (error) {
      setFailure({ message: signInErrorMessage(error), requestId: requestIdOf(error) });
    } finally {
      setBusy(false);
    }
  }

  const index = step.kind === 'start' ? 0 : step.kind === 'scan' ? 1 : 2;
  return (
    <div>
      <StepProgress
        label="Authenticator set-up"
        steps={['Start', 'Scan and confirm', 'Save recovery codes']}
        current={index}
      />
      {failure ? (
        <ErrorState
          title="Set-up not completed"
          message={failure.message}
          requestId={failure.requestId}
        />
      ) : null}
      {step.kind === 'start' ? (
        <>
          <p>
            You will need an authenticator app on your phone, such as Microsoft Authenticator,
            Google Authenticator or 1Password.
          </p>
          <Button onClick={() => void start()} disabled={busy}>
            Set up authenticator app
          </Button>
        </>
      ) : null}
      {step.kind === 'scan' ? (
        <>
          <p>Scan this QR code with your authenticator app, or type the key below into the app.</p>
          {isSafeQrSvg(step.qrSvg) ? (
            <figure className={styles.qr}>
              {/* The SVG comes from the API's QR library and is checked by isSafeQrSvg. */}
              <div
                role="img"
                aria-label="QR code for your authenticator app"
                dangerouslySetInnerHTML={{ __html: step.qrSvg }}
              />
            </figure>
          ) : (
            <Notice tone="warning" title="QR code not shown">
              <p>Type the key below into your authenticator app instead.</p>
            </Notice>
          )}
          <p>
            Key for manual entry:{' '}
            <code className={styles.key}>{step.manualKey.match(/.{1,4}/g)?.join(' ')}</code>
          </p>
          <form noValidate onSubmit={(e) => void confirm(e)} aria-label="Confirm authenticator app">
            <ErrorSummary errors={errors} />
            <TextInput
              id="enrol-code"
              label="Code shown in the app"
              hint="Six digits."
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              required
              error={errors[0]?.message}
            />
            <Button type="submit" disabled={busy}>
              Confirm
            </Button>
          </form>
        </>
      ) : null}
      {step.kind === 'done' ? (
        <>
          <Notice tone="success" title="Authenticator app set up">
            <p>From now on, signing in needs a code from the app.</p>
          </Notice>
          <Notice tone="warning" title="Save your recovery codes now">
            <p>
              Each code lets you sign in once if you lose your phone. They will not be shown again.
              Store them somewhere safe, such as a password manager.
            </p>
          </Notice>
          <ol className={styles.codes} aria-label="Recovery codes">
            {step.codes.map((c) => (
              <li key={c}>
                <code>{c}</code>
              </li>
            ))}
          </ol>
          <Button onClick={() => navigate('/')}>I have saved my codes — continue</Button>
        </>
      ) : null}
    </div>
  );
}
