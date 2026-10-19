import type { ReactNode } from 'react';
import styles from './forms.module.css';
import a11y from './a11y.module.css';

/**
 * Accessible form primitives on native HTML elements (ADR-024). One pattern everywhere:
 *  - a visible label linked to its control;
 *  - a visible mandatory marker (*) plus aria-required on the control;
 *  - an optional hint and a validation message, linked with aria-describedby;
 *  - aria-invalid while the field has an error.
 * Field ids are explicit so labels, messages and the error summary link reliably.
 */
interface FieldBase {
  readonly id: string;
  readonly label: string;
  readonly name?: string;
  readonly required?: boolean;
  readonly hint?: string;
  /** Validation message in plain language; shown below the control. */
  readonly error?: string | undefined;
}

function describedBy(field: FieldBase): string | undefined {
  const ids = [field.hint ? `${field.id}-hint` : null, field.error ? `${field.id}-error` : null];
  const joined = ids.filter((v): v is string => v !== null).join(' ');
  return joined.length > 0 ? joined : undefined;
}

function controlProps(field: FieldBase) {
  return {
    id: field.id,
    name: field.name ?? field.id,
    required: field.required === true,
    'aria-required': field.required === true ? true : undefined,
    'aria-invalid': field.error ? true : undefined,
    'aria-describedby': describedBy(field),
  } as const;
}

function FieldLabel({ field }: { readonly field: FieldBase }) {
  return (
    <label htmlFor={field.id} className={styles.label}>
      {field.label}
      {field.required ? (
        <span className={styles.required} aria-hidden="true">
          {' *'}
        </span>
      ) : null}
    </label>
  );
}

function FieldMessages({ field }: { readonly field: FieldBase }) {
  return (
    <>
      {field.hint ? (
        <p id={`${field.id}-hint`} className={styles.hint}>
          {field.hint}
        </p>
      ) : null}
      {field.error ? (
        <p id={`${field.id}-error`} className={styles.error}>
          <span className={a11y.visuallyHidden}>Error: </span>
          {field.error}
        </p>
      ) : null}
    </>
  );
}

function FieldFrame({
  field,
  children,
}: {
  readonly field: FieldBase;
  readonly children: ReactNode;
}) {
  return (
    <div className={`${styles.field} ${field.error ? styles.invalid : ''}`}>
      <FieldLabel field={field} />
      <FieldMessages field={field} />
      {children}
    </div>
  );
}

/** Explains the mandatory marker once per form. */
export function RequiredFieldsNote() {
  return (
    <p className={styles.note}>
      Fields marked <span aria-hidden="true">*</span>
      <span className={a11y.visuallyHidden}>with an asterisk</span> are required.
    </p>
  );
}

export function TextInput(
  props: FieldBase & {
    readonly defaultValue?: string;
    readonly autoComplete?: string;
    /** Native input type; text by default. */
    readonly type?: 'text' | 'email' | 'password';
    readonly inputMode?: 'text' | 'numeric' | 'email';
    readonly maxLength?: number;
  },
) {
  return (
    <FieldFrame field={props}>
      <input
        type={props.type ?? 'text'}
        inputMode={props.inputMode}
        maxLength={props.maxLength}
        spellCheck={props.type === 'password' ? false : undefined}
        className={styles.control}
        defaultValue={props.defaultValue}
        autoComplete={props.autoComplete ?? 'off'}
        {...controlProps(props)}
      />
    </FieldFrame>
  );
}

export function NumberInput(
  props: FieldBase & {
    readonly defaultValue?: number;
    readonly min?: number;
    readonly max?: number;
    readonly step?: number | 'any';
  },
) {
  return (
    <FieldFrame field={props}>
      <input
        type="number"
        inputMode="decimal"
        className={styles.control}
        defaultValue={props.defaultValue}
        min={props.min}
        max={props.max}
        step={props.step}
        {...controlProps(props)}
      />
    </FieldFrame>
  );
}

export function Select(
  props: FieldBase & {
    readonly options: ReadonlyArray<{ readonly value: string; readonly label: string }>;
    readonly defaultValue?: string;
    /** Shown first, with an empty value, so "nothing chosen" is explicit. */
    readonly placeholder?: string;
  },
) {
  return (
    <FieldFrame field={props}>
      <select
        className={styles.control}
        defaultValue={props.defaultValue ?? ''}
        {...controlProps(props)}
      >
        <option value="">{props.placeholder ?? 'Select…'}</option>
        {props.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </FieldFrame>
  );
}

export function TextArea(
  props: FieldBase & {
    readonly defaultValue?: string;
    readonly maxLength?: number;
    readonly rows?: number;
  },
) {
  return (
    <FieldFrame field={props}>
      <textarea
        className={styles.control}
        defaultValue={props.defaultValue}
        maxLength={props.maxLength}
        rows={props.rows ?? 4}
        {...controlProps(props)}
      />
    </FieldFrame>
  );
}

/**
 * A group of checkboxes with one shared question (fieldset + legend), e.g. "Permissions".
 * Values are read with FormData.getAll(name). Each option can carry its own hint.
 */
export function CheckboxGroup({
  id,
  legend,
  name,
  hint,
  error,
  options,
  defaultValues = [],
}: {
  readonly id: string;
  readonly legend: string;
  readonly name?: string;
  readonly hint?: string;
  readonly error?: string | undefined;
  readonly options: ReadonlyArray<{
    readonly value: string;
    readonly label: string;
    readonly hint?: string;
  }>;
  readonly defaultValues?: readonly string[];
}) {
  const described =
    [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(' ') ||
    undefined;
  return (
    <fieldset
      id={id}
      className={`${styles.fieldset} ${error ? styles.invalid : ''}`}
      aria-describedby={described}
    >
      <legend className={styles.legend}>{legend}</legend>
      {hint ? (
        <p id={`${id}-hint`} className={styles.hint}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} className={styles.error}>
          <span className={a11y.visuallyHidden}>Error: </span>
          {error}
        </p>
      ) : null}
      {options.length === 0 ? <p className={styles.hint}>Nothing to choose from yet.</p> : null}
      {options.map((o, i) => {
        const optionId = `${id}-${i}`;
        return (
          <div key={o.value} className={styles.checkboxRow}>
            <input
              type="checkbox"
              id={optionId}
              name={name ?? id}
              value={o.value}
              className={styles.checkbox}
              defaultChecked={defaultValues.includes(o.value)}
              aria-describedby={o.hint ? `${optionId}-hint` : undefined}
            />
            <div>
              <label htmlFor={optionId}>{o.label}</label>
              {o.hint ? (
                <span id={`${optionId}-hint`} className={styles.optionHint}>
                  {o.hint}
                </span>
              ) : null}
            </div>
          </div>
        );
      })}
    </fieldset>
  );
}

export function Checkbox(props: FieldBase & { readonly defaultChecked?: boolean }) {
  return (
    <div className={`${styles.field} ${styles.checkboxField} ${props.error ? styles.invalid : ''}`}>
      <div className={styles.checkboxRow}>
        <input
          type="checkbox"
          className={styles.checkbox}
          defaultChecked={props.defaultChecked}
          {...controlProps(props)}
        />
        <FieldLabel field={props} />
      </div>
      <FieldMessages field={props} />
    </div>
  );
}

export function Button({
  children,
  type = 'button',
  variant = 'primary',
  onClick,
  disabled,
}: {
  readonly children: ReactNode;
  readonly type?: 'button' | 'submit' | 'reset';
  readonly variant?: 'primary' | 'secondary';
  readonly onClick?: () => void;
  readonly disabled?: boolean;
}) {
  return (
    <button
      type={type}
      className={`${styles.button} ${styles[variant]}`}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}
