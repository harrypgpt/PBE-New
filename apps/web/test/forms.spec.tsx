import { render, screen } from '@testing-library/react';
import { ErrorSummary } from '../src/ui/ErrorSummary';
import {
  Button,
  Checkbox,
  NumberInput,
  RequiredFieldsNote,
  Select,
  TextInput,
} from '../src/ui/forms';

describe('S5-1 accessible form primitives', () => {
  it('links the label to the control and marks a required field visibly and with aria-required', () => {
    render(<TextInput id="batch" label="Batch name" required />);
    const input = screen.getByRole('textbox', { name: /Batch name/ });
    expect(input.id).toBe('batch');
    expect(input.getAttribute('aria-required')).toBe('true');
    expect(input.hasAttribute('required')).toBe(true);
    // The visible marker is decorative for screen readers (aria-required already says it).
    const marker = screen.getByText('*', { exact: false, selector: 'span[aria-hidden="true"]' });
    expect(marker).toBeTruthy();
  });

  it('an optional field has no required marker or aria-required', () => {
    render(<TextInput id="notes" label="Notes" />);
    const input = screen.getByRole('textbox', { name: 'Notes' });
    expect(input.hasAttribute('aria-required')).toBe(false);
    expect(document.querySelector('span[aria-hidden="true"]')).toBeNull();
  });

  it('links hint and validation message with aria-describedby and sets aria-invalid', () => {
    render(
      <NumberInput
        id="count"
        label="Count"
        required
        hint="Whole number."
        error="Enter 1 or more"
      />,
    );
    const input = screen.getByRole('spinbutton', { name: /Count/ });
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')).toBe('count-hint count-error');
    expect(document.getElementById('count-hint')?.textContent).toBe('Whole number.');
    expect(document.getElementById('count-error')?.textContent).toBe('Error: Enter 1 or more');
  });

  it('a field without an error is not marked invalid', () => {
    render(<NumberInput id="n" label="Number" />);
    expect(screen.getByRole('spinbutton', { name: 'Number' }).hasAttribute('aria-invalid')).toBe(
      false,
    );
  });

  it('select starts with an explicit empty choice; checkbox is labelled', () => {
    render(
      <>
        <Select id="kind" label="Type" required options={[{ value: 'a', label: 'A' }]} />
        <Checkbox id="ok" label="I confirm" required error="Confirm this" />
      </>,
    );
    const select = screen.getByRole('combobox', { name: /Type/ }) as HTMLSelectElement;
    expect(select.value).toBe('');
    expect(select.getAttribute('aria-required')).toBe('true');
    const box = screen.getByRole('checkbox', { name: /I confirm/ });
    expect(box.getAttribute('aria-describedby')).toBe('ok-error');
  });

  it('explains the mandatory marker once per form', () => {
    render(<RequiredFieldsNote />);
    expect(screen.getByText(/are required/).textContent).toMatch(
      /Fields marked \*with an asterisk are required/,
    );
  });

  it('buttons default to type="button" so they never submit by accident', () => {
    render(<Button>Do it</Button>);
    expect(screen.getByRole('button', { name: 'Do it' }).getAttribute('type')).toBe('button');
  });
});

describe('S5-1 error summary', () => {
  it('renders nothing without errors', () => {
    const { container } = render(<ErrorSummary errors={[]} />);
    expect(container.innerHTML).toBe('');
  });

  it('lists each problem as a link to its field and takes focus', () => {
    render(
      <ErrorSummary
        errors={[
          { fieldId: 'batch', message: 'Enter a batch name' },
          { fieldId: 'count', message: 'Enter 1 or more' },
        ]}
      />,
    );
    const alert = screen.getByRole('alert', { name: 'There is a problem' });
    expect(document.activeElement).toBe(alert);
    expect(screen.getByRole('link', { name: 'Enter a batch name' }).getAttribute('href')).toBe(
      '#batch',
    );
    expect(screen.getByRole('link', { name: 'Enter 1 or more' }).getAttribute('href')).toBe(
      '#count',
    );
  });
});
