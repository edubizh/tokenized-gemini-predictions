"use client";

import { useId, type InputHTMLAttributes } from "react";
import styles from "./Field.module.css";

export interface FieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "onChange" | "value" | "prefix"> {
  label: string;
  value: string;
  onChange(value: string): void;
  /** Mono and right aligned, for prices and quantities. */
  numeric?: boolean;
  /** Unit shown inside the control before the value, such as `$`. */
  prefix?: string;
  /** Unit shown inside the control after the value, such as `contracts`. */
  suffix?: string;
  helper?: string;
  /** What is wrong and what is allowed. Replaces the helper. */
  error?: string;
  /** Plain minus and plus buttons beside the control. */
  stepper?: { onDecrement(): void; onIncrement(): void; canDecrement?: boolean; canIncrement?: boolean };
}

export function Field({ label, value, onChange, numeric, prefix, suffix, helper, error, stepper, disabled, id, ...rest }: FieldProps) {
  const generated = useId();
  const inputId = id ?? generated;
  const noteId = `${inputId}-note`;
  const note = error ?? helper;
  const name = label.toLowerCase();

  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={inputId}>
        {label}
      </label>
      <div className={styles.line}>
        {stepper && (
          <button type="button" className={styles.step} onClick={stepper.onDecrement} disabled={disabled || stepper.canDecrement === false} aria-label={`Decrease ${name}`}>
            <span aria-hidden="true">−</span>
          </button>
        )}
        <div className={styles.control} data-invalid={error ? "" : undefined} data-disabled={disabled ? "" : undefined}>
          {prefix && (
            <span className={styles.unit} aria-hidden="true">
              {prefix}
            </span>
          )}
          <input
            {...rest}
            id={inputId}
            className={`${styles.input} ${numeric ? styles.numeric : ""}`}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            disabled={disabled}
            inputMode={numeric ? "decimal" : rest.inputMode}
            autoComplete={rest.autoComplete ?? "off"}
            aria-invalid={error ? true : undefined}
            aria-describedby={note ? noteId : undefined}
          />
          {suffix && (
            <span className={styles.unit} aria-hidden="true">
              {suffix}
            </span>
          )}
        </div>
        {stepper && (
          <button type="button" className={styles.step} onClick={stepper.onIncrement} disabled={disabled || stepper.canIncrement === false} aria-label={`Increase ${name}`}>
            <span aria-hidden="true">+</span>
          </button>
        )}
      </div>
      {note && (
        <p id={noteId} className={error ? styles.error : styles.helper}>
          {(prefix || suffix) && <span className="sr-only">{`In ${suffix ?? (prefix === "$" ? "dollars" : prefix)}. `}</span>}
          {note}
        </p>
      )}
    </div>
  );
}
