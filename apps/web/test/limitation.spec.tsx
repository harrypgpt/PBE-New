import { render, screen } from '@testing-library/react';
import { LIMITATION_STATEMENT } from '../src/content/limitation';
import { AppShell } from '../src/ui/AppShell';
import { LimitationStatement } from '../src/ui/LimitationStatement';

// React logs caught render errors to the console; keep test output readable.
function silenceRenderErrors() {
  return jest.spyOn(console, 'error').mockImplementation(() => undefined);
}

describe('S5-2 limitation statement (baseline B5-4)', () => {
  it('renders the given text in a labelled note region', () => {
    render(<LimitationStatement text="Outputs can be wrong." />);
    const note = screen.getByRole('note', { name: 'Limitation statement' });
    expect(note.textContent).toBe('Limitations: Outputs can be wrong.');
  });

  it.each([[''], ['   '], ['\n\t']])('refuses empty or blank text (%j)', (text) => {
    const spy = silenceRenderErrors();
    expect(() => render(<LimitationStatement text={text} />)).toThrow(/non-empty/);
    spy.mockRestore();
  });

  it('refuses a missing text at run time too', () => {
    const spy = silenceRenderErrors();
    expect(() => render(<LimitationStatement {...({} as { text: string })} />)).toThrow(
      /non-empty/,
    );
    spy.mockRestore();
  });

  it('no prop can hide it (unknown props such as hidden, className or style are ignored)', () => {
    const sneaky = { text: 'Visible.', hidden: true, className: 'x', style: { display: 'none' } };
    render(<LimitationStatement {...(sneaky as unknown as { text: string })} />);
    const note = screen.getByRole('note', { name: 'Limitation statement' });
    expect(note.hasAttribute('hidden')).toBe(false);
    expect(note.getAttribute('style')).toBeNull();
  });

  it('the shell always shows it, before the page content', () => {
    render(
      <AppShell session={null} navigation={null} limitation={LIMITATION_STATEMENT}>
        <h1>Page</h1>
      </AppShell>,
    );
    const note = screen.getByRole('note', { name: 'Limitation statement' });
    expect(note.textContent).toContain('decision support');
    const main = screen.getByRole('main');
    expect(note.compareDocumentPosition(main) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('the shell cannot be rendered with a blank statement', () => {
    const spy = silenceRenderErrors();
    expect(() =>
      render(
        <AppShell session={null} navigation={null} limitation=" ">
          <p>x</p>
        </AppShell>,
      ),
    ).toThrow(/non-empty/);
    spy.mockRestore();
  });

  it('the configured statement is non-empty and says outputs need human judgement', () => {
    expect(LIMITATION_STATEMENT.trim().length).toBeGreaterThan(50);
    expect(LIMITATION_STATEMENT).toMatch(/can be wrong/);
    expect(LIMITATION_STATEMENT).toMatch(/do not guarantee bioequivalence/);
  });
});
