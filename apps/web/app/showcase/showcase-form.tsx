'use client';

import { useState, type FormEvent } from 'react';
import { ErrorSummary, type FieldError } from '../../src/ui/ErrorSummary';
import { Notice } from '../../src/ui/feedback';
import {
  Button,
  Checkbox,
  NumberInput,
  RequiredFieldsNote,
  Select,
  TextInput,
} from '../../src/ui/forms';

/** Example form showing the validation pattern: messages per field plus a focused summary. */
export function ShowcaseForm() {
  const [errors, setErrors] = useState<readonly FieldError[]>([]);
  const [submitted, setSubmitted] = useState(false);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const found: FieldError[] = [];
    if (String(data.get('example-name') ?? '').trim() === '') {
      found.push({ fieldId: 'example-name', message: 'Enter a name' });
    }
    const count = Number(data.get('example-count'));
    if (String(data.get('example-count') ?? '') === '' || !Number.isInteger(count) || count < 1) {
      found.push({ fieldId: 'example-count', message: 'Enter a whole number of 1 or more' });
    }
    if (String(data.get('example-kind') ?? '') === '') {
      found.push({ fieldId: 'example-kind', message: 'Select a type' });
    }
    if (data.get('example-confirm') === null) {
      found.push({ fieldId: 'example-confirm', message: 'Confirm that this is example data' });
    }
    setErrors(found);
    setSubmitted(found.length === 0);
  }

  const errorFor = (id: string) => errors.find((e) => e.fieldId === id)?.message;

  return (
    <form noValidate onSubmit={onSubmit} aria-label="Example form">
      <ErrorSummary errors={errors} />
      {submitted ? (
        <Notice tone="success" title="Example form submitted. Nothing was saved." />
      ) : null}
      <RequiredFieldsNote />
      <TextInput
        id="example-name"
        label="Name"
        required
        hint="Any text."
        error={errorFor('example-name')}
      />
      <NumberInput
        id="example-count"
        label="Count"
        required
        min={1}
        step={1}
        error={errorFor('example-count')}
      />
      <Select
        id="example-kind"
        label="Type"
        required
        options={[
          { value: 'a', label: 'Example type A' },
          { value: 'b', label: 'Example type B' },
        ]}
        error={errorFor('example-kind')}
      />
      <TextInput id="example-notes" label="Notes" hint="Optional." />
      <Checkbox
        id="example-confirm"
        label="This is example data"
        required
        error={errorFor('example-confirm')}
      />
      <Button type="submit">Check form</Button>
    </form>
  );
}
