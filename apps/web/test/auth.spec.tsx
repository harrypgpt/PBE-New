import { act, fireEvent, render, screen } from '@testing-library/react';
import { LoginForm } from '../src/auth/LoginForm';
import { isSafeQrSvg } from '../src/auth/MfaEnrolment';
import { MfaVerifyForm } from '../src/auth/MfaVerifyForm';
import { PasswordChangeForm } from '../src/auth/PasswordChangeForm';
import { NAVIGATION, visibleNavItems } from '../src/navigation';

const REQUEST_ID = '0f9e8d7c-6b5a-4c3d-8e2f-1a0b9c8d7e6f';

function mockFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return {
      status,
      headers: { get: (h: string) => (h === 'x-request-id' ? REQUEST_ID : null) },
      text: async () => JSON.stringify(body),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return calls;
}

const problem = (status: number, code: string, detail: string) => ({
  type: `https://pbe.local/problems/${code.toLowerCase().replace(/_/g, '-')}`,
  title: 'x',
  status,
  code,
  detail,
  requestId: REQUEST_ID,
});

function fill(label: RegExp, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

describe('S6-19 (unit part) sign-in form', () => {
  it('has labelled email and password fields with the right autocomplete and types', () => {
    render(<LoginForm navigate={() => undefined} />);
    const email = screen.getByLabelText(/Email address/) as HTMLInputElement;
    const password = screen.getByLabelText(/^Password/) as HTMLInputElement;
    expect([email.type, email.autocomplete]).toEqual(['email', 'username']);
    expect([password.type, password.autocomplete]).toEqual(['password', 'current-password']);
  });

  it('checks empty fields before sending anything', async () => {
    const calls = mockFetch(200, { next: 'done' });
    render(<LoginForm navigate={() => undefined} />);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Sign in' })));
    expect(screen.getByRole('alert', { name: 'There is a problem' })).toBeTruthy();
    expect(calls).toHaveLength(0);
  });

  it('goes to the next step the API names', async () => {
    mockFetch(200, { next: 'mfa' });
    const navigate = jest.fn();
    render(<LoginForm navigate={navigate} />);
    fill(/Email address/, 'fictional@example.test');
    fill(/^Password/, 'any-password-value');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Sign in' })));
    expect(navigate).toHaveBeenCalledWith('/login/mfa');
  });

  it('shows the same plain message for any failed sign-in, with the support reference', async () => {
    mockFetch(
      401,
      problem(401, 'AUTHENTICATION_FAILED', 'The email address or password is not correct.'),
    );
    render(<LoginForm navigate={() => undefined} />);
    fill(/Email address/, 'fictional@example.test');
    fill(/^Password/, 'any-password-value');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Sign in' })));
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('The email address or password is not correct.');
    expect(alert.textContent).toContain(REQUEST_ID);
    expect(alert.textContent).not.toContain('any-password-value');
  });

  it('explains throttling without revealing anything about the account', async () => {
    mockFetch(429, problem(429, 'TOO_MANY_ATTEMPTS', 'Please wait a few minutes and try again.'));
    render(<LoginForm navigate={() => undefined} />);
    fill(/Email address/, 'fictional@example.test');
    fill(/^Password/, 'any-password-value');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Sign in' })));
    expect(screen.getByRole('alert').textContent).toContain('Too many attempts');
  });
});

describe('MFA verification form', () => {
  it('accepts only 6 digits for an app code, and switches to recovery codes', async () => {
    const calls = mockFetch(200, { next: 'done' });
    const navigate = jest.fn();
    render(<MfaVerifyForm navigate={navigate} />);
    fill(/Code from your authenticator app/, '12345');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Verify' })));
    expect(calls).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Use a recovery code instead' }));
    fill(/Recovery code/, 'ABCDE-23456');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Verify' })));
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ recoveryCode: 'ABCDE-23456' });
    expect(navigate).toHaveBeenCalledWith('/');
  });
});

describe('password change form', () => {
  it('checks length (15–128) and that both new passwords match, before sending', async () => {
    const calls = mockFetch(200, { status: 'changed' });
    render(<PasswordChangeForm />);
    fill(/Current password/, 'current-password-value');
    fill(/^New password/, 'too-short');
    fill(/Repeat the new password/, 'different');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Change password' })));
    const summary = screen.getByRole('alert', { name: 'There is a problem' });
    expect(summary.textContent).toContain('Use 15 to 128 characters');
    expect(summary.textContent).toContain('do not match');
    expect(calls).toHaveLength(0);
  });

  it('shows the API’s policy message when the new password is refused', async () => {
    mockFetch(400, {
      ...problem(
        400,
        'VALIDATION_FAILED',
        'This password is too common or has appeared in a data breach. Choose another.',
      ),
      errors: [{ path: 'body.newPassword', message: 'x' }],
    });
    render(<PasswordChangeForm />);
    fill(/Current password/, 'current-password-value');
    fill(/^New password/, 'a-long-enough-new-password');
    fill(/Repeat the new password/, 'a-long-enough-new-password');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Change password' })));
    expect(screen.getByRole('alert').textContent).toContain('data breach');
  });
});

describe('QR code safety check (defence in depth)', () => {
  it('accepts plain SVG and refuses scripts, handlers, links and styles', () => {
    expect(
      isSafeQrSvg(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 29 29"><path fill="#ffffff" d="M0 0h29v29H0z"/></svg>\n',
      ),
    ).toBe(true);
    for (const bad of [
      '<svg><script>alert(1)</script></svg>',
      '<svg onload="alert(1)"></svg>',
      '<svg><a href="javascript:alert(1)">x</a></svg>',
      '<svg><foreignObject></foreignObject></svg>',
      '<svg style="x"></svg>',
      '<div></div>',
    ]) {
      expect(isSafeQrSvg(bad)).toBe(false);
    }
  });
});

describe('navigation by sign-in state (presentation only)', () => {
  const session = { user: { displayName: 'Fictional' }, tenant: null, permissions: [] };
  const labels = (s: typeof session | null) =>
    visibleNavItems(NAVIGATION, s)
      .filter((i) => i.kind === 'link')
      .map((i) => i.label);

  it('signed out: Sign in; signed in: Account security', () => {
    expect(labels(null)).toEqual(['Home', 'System status', 'Sign in']);
    // Stage 7B: every signed-in user also gets "Organisation" (choose where to work).
    expect(labels(session)).toEqual(['Home', 'System status', 'Account security', 'Organisation']);
  });
});
