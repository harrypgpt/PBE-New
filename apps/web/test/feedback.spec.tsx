import { act, render, screen } from '@testing-library/react';
import ErrorPage from '../app/error';
import type { HealthResult } from '../src/api-client/health';
import { StatusPanel } from '../src/status/StatusPanel';
import { DataTable } from '../src/ui/DataTable';
import { ErrorState, LoadingState, Notice, StatusLabel } from '../src/ui/feedback';
import { StepProgress, ValueProgress } from '../src/ui/progress';

const silence = () => jest.spyOn(console, 'error').mockImplementation(() => undefined);

describe('S5-1 progress indicator', () => {
  it('step progress marks the current step and announces each state', () => {
    render(<StepProgress label="Workflow" steps={['One', 'Two', 'Three']} current={1} />);
    const nav = screen.getByRole('navigation', { name: 'Workflow' });
    const items = nav.querySelectorAll('li');
    expect(items[1]!.getAttribute('aria-current')).toBe('step');
    expect(items[0]!.textContent).toContain('(completed)');
    expect(items[1]!.textContent).toContain('(current step)');
    expect(items[2]!.textContent).toContain('(not started)');
  });

  it('value progress is a labelled native progressbar with a real value', () => {
    render(<ValueProgress id="p" label="Files checked" value={3} max={8} />);
    const bar = screen.getByRole('progressbar', { name: 'Files checked' }) as HTMLProgressElement;
    expect(bar.value).toBe(3);
    expect(bar.max).toBe(8);
    expect(screen.getByText('3 of 8', { selector: 'span' })).toBeTruthy();
  });

  it.each([
    [-1, 8],
    [9, 8],
    [1, 0],
    [Number.NaN, 8],
  ])('refuses impossible progress (%p of %p): no fake progress', (value, max) => {
    const spy = silence();
    expect(() => render(<ValueProgress id="p" label="x" value={value} max={max} />)).toThrow();
    spy.mockRestore();
  });

  it('refuses an out-of-range current step', () => {
    const spy = silence();
    expect(() => render(<StepProgress label="x" steps={['a']} current={1} />)).toThrow();
    spy.mockRestore();
  });
});

describe('S5-1 loading and error states show no technical detail', () => {
  it('loading state is a polite status with a label', () => {
    render(<LoadingState label="Loading projects…" />);
    expect(screen.getByRole('status').textContent).toBe('Loading projects…');
  });

  it('error state shows only the plain message and the support reference', () => {
    render(<ErrorState title="Could not load" message="Please try again." requestId="abc-123" />);
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toBe('Could not loadPlease try again.Reference for support: abc-123');
  });

  it("the app error page never shows the error's message or stack", () => {
    const error = new Error('SELECT password FROM credentials -- at db.ts:12 pbe_app');
    error.stack = 'Error: boom\n    at secret (/srv/app/db.ts:12:3)';
    render(<ErrorPage error={error} reset={() => undefined} />);
    const text = document.body.textContent ?? '';
    expect(text).toContain('This page could not be shown');
    for (const leak of ['SELECT', 'password', 'db.ts', 'pbe_app', 'Error:', '/srv']) {
      expect(text).not.toContain(leak);
    }
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});

describe('S5-19 baseline patterns: status labels, notices, tables', () => {
  it('status label always has text (never colour alone) and refuses blank text', () => {
    render(<StatusLabel tone="success" text="Approved" />);
    expect(screen.getByText('Approved').className).toContain('success');
    const spy = silence();
    expect(() => render(<StatusLabel tone="error" text=" " />)).toThrow(/visible text/);
    spy.mockRestore();
  });

  it.each([
    ['success', 'status'],
    ['info', 'status'],
    ['warning', 'status'],
    ['error', 'alert'],
  ] as const)('a %s notice uses role="%s"', (tone, role) => {
    render(<Notice tone={tone} title={`A ${tone} notice`} />);
    expect(screen.getByRole(role).textContent).toBe(`A ${tone} notice`);
  });

  interface Row {
    readonly id: string;
    readonly name: string;
  }
  const columns = [
    { key: 'id', header: 'ID', cell: (r: Row) => r.id },
    { key: 'name', header: 'Name', cell: (r: Row) => r.name },
  ];

  it('data table: caption, column headers with scope, rows, scrollable labelled region', () => {
    render(
      <DataTable
        id="t"
        caption="Projects"
        columns={columns}
        rows={[{ id: '1', name: 'Alpha' }]}
        rowKey={(r) => r.id}
        emptyMessage="None"
      />,
    );
    const table = screen.getByRole('table', { name: 'Projects' });
    const headers = table.querySelectorAll('th');
    expect([...headers].map((h) => [h.textContent, h.getAttribute('scope')])).toEqual([
      ['ID', 'col'],
      ['Name', 'col'],
    ]);
    expect(screen.getByRole('cell', { name: 'Alpha' })).toBeTruthy();
    const region = screen.getByRole('region', { name: 'Projects' });
    expect(region.getAttribute('tabindex')).toBe('0');
  });

  it('data table: explicit empty state and loading state', () => {
    const { rerender } = render(
      <DataTable
        id="t"
        caption="Users"
        columns={columns}
        rows={[]}
        rowKey={(r) => r.id}
        emptyMessage="No users yet."
      />,
    );
    expect(screen.getByRole('cell', { name: 'No users yet.' })).toBeTruthy();
    rerender(
      <DataTable
        id="t"
        caption="Users"
        columns={columns}
        rows={[]}
        rowKey={(r) => r.id}
        emptyMessage="No users yet."
        loading
      />,
    );
    expect(screen.getByRole('table').getAttribute('aria-busy')).toBe('true');
    expect(screen.getByRole('status').textContent).toBe('Loading users…');
  });
});

describe('S5-6 (unit part) status panel states', () => {
  async function renderPanel(result: HealthResult | Error) {
    const check = () =>
      result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
    await act(async () => {
      render(<StatusPanel check={check} />);
    });
  }

  it('available', async () => {
    await renderPanel({ available: true, requestId: '6f1c2b8e-1d2a-4c3b-9e8f-7a6b5c4d3e2f' });
    expect(screen.getByRole('status').textContent).toContain('API and database: available');
    expect(screen.getByText('Available')).toBeTruthy();
  });

  it('unavailable, with the support reference only', async () => {
    await renderPanel({ available: false, requestId: '6f1c2b8e-1d2a-4c3b-9e8f-7a6b5c4d3e2f' });
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('API and database: unavailable');
    expect(alert.textContent).toContain('6f1c2b8e-1d2a-4c3b-9e8f-7a6b5c4d3e2f');
  });

  it('an unexpected failure is still shown as plain "unavailable", with no error text', async () => {
    await renderPanel(new Error('ECONNREFUSED 127.0.0.1:5432 password authentication failed'));
    const text = document.body.textContent ?? '';
    expect(text).toContain('API and database: unavailable');
    expect(text).not.toMatch(/ECONNREFUSED|5432|password/);
  });
});
