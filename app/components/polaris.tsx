// Small React wrappers for Polaris web component form fields.
// React 18 does not pass event handlers or live values to custom elements, so each wrapper listens to
// the element's own "input" / "change" events and sets `value` / `checked` as properties.
// React 18 also turns `disabled={false}` into the attribute disabled="false", which still disables the
// element: boolean attributes are only added when true (see `flag`).
import { useEffect, useRef, type ReactNode } from "react";

export const flag = (name: string, on: unknown) => (on ? { [name]: true } : {});

function useField<T extends HTMLElement>(
  event: "input" | "change",
  read: (el: T) => void,
) {
  const ref = useRef<T>(null);
  // The latest handler, so the listener below is added once
  const readRef = useRef(read);
  useEffect(() => {
    readRef.current = read;
  });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fn = () => readRef.current(el);
    el.addEventListener(event, fn);
    return () => el.removeEventListener(event, fn);
  }, [event]);
  return ref;
}

interface TextProps {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  details?: string;
  error?: string;
  labelHidden?: boolean;
}

export function TextField({ label, value, onChange, placeholder, details, error, labelHidden }: TextProps) {
  const ref = useField<HTMLElementTagNameMap["s-text-field"]>("input", (el) => onChange(el.value));
  useEffect(() => {
    if (ref.current && ref.current.value !== value) ref.current.value = value;
  }, [value, ref]);
  return (
    <s-text-field
      ref={ref}
      label={label}
      placeholder={placeholder}
      {...(details ? { details } : {})}
      {...(error ? { error } : {})}
      {...(labelHidden ? { labelAccessibilityVisibility: "exclusive" as const } : {})}
    />
  );
}

export function NumberField({
  label,
  value,
  onChange,
  placeholder,
  details,
  min,
  max,
}: Omit<TextProps, "value" | "onChange"> & { value: number | ""; onChange: (v: number | "") => void; min?: number; max?: number }) {
  const ref = useField<HTMLElementTagNameMap["s-number-field"]>("input", (el) => {
    const n = el.value === "" ? "" : Number(el.value);
    onChange(n === "" || Number.isFinite(n) ? n : "");
  });
  useEffect(() => {
    const v = value === "" ? "" : String(value);
    if (ref.current && ref.current.value !== v) ref.current.value = v;
  }, [value, ref]);
  return (
    <s-number-field
      ref={ref}
      label={label}
      placeholder={placeholder}
      {...(details ? { details } : {})}
      {...(min != null ? { min } : {})}
      {...(max != null ? { max } : {})}
    />
  );
}

export function Select({
  label,
  value,
  onChange,
  options,
  details,
  labelHidden,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  details?: string;
  labelHidden?: boolean;
}) {
  const ref = useField<HTMLElementTagNameMap["s-select"]>("change", (el) => onChange(el.value));
  useEffect(() => {
    if (ref.current && ref.current.value !== value) ref.current.value = value;
  }, [value, ref, options]);
  return (
    <s-select
      ref={ref}
      label={label}
      {...(details ? { details } : {})}
      {...(labelHidden ? { labelAccessibilityVisibility: "exclusive" as const } : {})}
    >
      {options.map((o) => (
        <s-option key={o.value} value={o.value}>
          {o.label}
        </s-option>
      ))}
    </s-select>
  );
}

export function Checkbox({
  label,
  checked,
  onChange,
  details,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  details?: string;
}) {
  const ref = useField<HTMLElementTagNameMap["s-checkbox"]>("change", (el) => onChange(!!el.checked));
  useEffect(() => {
    if (ref.current && ref.current.checked !== checked) ref.current.checked = checked;
  }, [checked, ref]);
  return <s-checkbox ref={ref} label={label} {...(details ? { details } : {})} />;
}

export function Button({
  children,
  onClick,
  variant,
  tone,
  disabled,
  loading,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "primary" | "secondary" | "tertiary";
  tone?: "critical";
  disabled?: boolean;
  loading?: boolean;
}) {
  return (
    <s-button
      onClick={disabled || loading ? undefined : onClick}
      {...(variant ? { variant } : {})}
      {...(tone ? { tone } : {})}
      {...flag("disabled", disabled)}
      {...flag("loading", loading)}
    >
      {children}
    </s-button>
  );
}

// A choice shown as a row of buttons ("File / Google Sheet"), the chosen one highlighted.
// Not s-button-group: it does not show a primary button among its secondary actions.
export function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <s-stack direction="inline" gap="small-200">
      {options.map((o) => (
        <s-button
          key={o.value}
          onClick={() => onChange(o.value)}
          variant={o.value === value ? "primary" : "secondary"}
          {...(o.value === value ? { accessibilityLabel: `${o.label} (selected)` } : {})}
        >
          {o.label}
        </s-button>
      ))}
    </s-stack>
  );
}
