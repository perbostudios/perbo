/**
 * The renderer's primitives: controls, page chrome, icons and motion. Every
 * screen imports them from here; nothing here reads data, IPC or tickets.
 */
import { forwardRef, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ButtonHTMLAttributes, ReactNode } from "react";

import { cx } from "./internal/cx.js";
import { InkIcon } from "./internal/InkIcon.js";

export { cx } from "./internal/cx.js";
export { Dropdown } from "./internal/Dropdown.js";
export { InkIcon } from "./internal/InkIcon.js";
export { LineIcon } from "./internal/LineIcon.js";
export type { LineIconName } from "./internal/LineIcon.js";
export {
  Brand,
  FactList,
  HeaderSlotProvider,
  PageFooter,
  PageHeader,
  ProgressDots,
  SectionLabel,
  TitleBar,
} from "./internal/page.js";
export { NumberPop, SuccessMark, ThinkingStatus } from "./internal/motion.js";
export { useElapsed } from "./internal/elapsed.js";

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: "primary" | "secondary" | "ghost" | "danger";
  }
>(function Button({ variant = "secondary", className, ...props }, ref) {
  return (
    <button
      ref={ref}
      className={cx("button", `button--${variant}`, className)}
      {...props}
    />
  );
});

export function IconButton({
  icon,
  label,
  onClick,
  size = 18,
  disabled = false,
}: {
  icon: Parameters<typeof InkIcon>[0]["name"];
  label: string;
  onClick: () => void;
  size?: number;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className="icon-button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
    >
      <InkIcon name={icon} size={size} />
    </button>
  );
}
export function PaginationButton({
  previous = false,
  disabled,
  onClick,
}: {
  previous?: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className="pagination-button"
      aria-label={previous ? "Previous page" : "Next page"}
      disabled={disabled}
      onClick={onClick}
    >
      <img
        src={"./brand/" + (previous ? "previous-page.svg" : "next-page.svg")}
        width="8"
        height="12"
        alt=""
      />
    </button>
  );
}

export function Field({
  label,
  hint,
  children,
  id,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  id: string;
}): ReactNode {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children}
      {hint && (
        <p id={`${id}-hint`} className="field-hint">
          {hint}
        </p>
      )}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  children,
  action,
}: {
  icon?: ReactNode;
  title: string;
  children: ReactNode;
  action?: ReactNode;
}): ReactNode {
  return (
    <div className="empty-state">
      {icon && <div className="empty-state-icon">{icon}</div>}
      <h2>{title}</h2>
      <p>{children}</p>
      {action}
    </div>
  );
}

/** Native dialog provides focus containment and an inert background. Restore the opener on exit. */
export function Dialog({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}): ReactNode {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const opener = document.activeElement;
    ref.current?.showModal();
    return () => {
      if (opener instanceof HTMLElement) opener.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={cx("dialog", "t-modal", "is-open")}
      aria-label={title}
      onCancel={onClose}
    >
      <div className="dialog-header">
        <h2>{title}</h2>
        <Button variant="ghost" onClick={onClose} aria-label="Close dialog">
          ×
        </Button>
      </div>
      {children}
    </dialog>
  );
}

export function Notice({
  children,
  tone = "warning",
}: {
  children: ReactNode;
  tone?: "warning" | "danger" | "success";
}): ReactNode {
  return (
    <div
      className={`notice notice--${tone}`}
      role={tone === "danger" ? "alert" : "status"}
    >
      {children}
    </div>
  );
}

/** A segmented control on the transitions.dev sliding-tabs transition: the pill is positioned from the selected tab's box. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: ReactNode }[];
  onChange: (value: T) => void;
  label: string;
}): ReactNode {
  const bar = useRef<HTMLDivElement>(null);
  const pill = useRef<HTMLSpanElement>(null);
  const first = useRef(true);
  useLayoutEffect(() => {
    const active = bar.current?.querySelector<HTMLButtonElement>(
      '.t-tab[aria-selected="true"]',
    );
    const element = pill.current;
    if (!active || !element) return;
    const move = (animate: boolean): void => {
      if (!animate) {
        const previous = element.style.transition;
        element.style.transition = "none";
        element.style.transform = `translateX(${active.offsetLeft}px)`;
        element.style.width = `${active.offsetWidth}px`;
        void element.offsetWidth;
        element.style.transition = previous;
      } else {
        element.style.transform = `translateX(${active.offsetLeft}px)`;
        element.style.width = `${active.offsetWidth}px`;
      }
    };
    move(!first.current);
    first.current = false;
    const resized = (): void => move(false);
    window.addEventListener("resize", resized);
    return () => window.removeEventListener("resize", resized);
  }, [value]);
  return (
    <div
      ref={bar}
      className={cx("t-tabs", "segmented")}
      role="tablist"
      aria-label={label}
    >
      <span ref={pill} className="t-tabs-pill" aria-hidden="true" />
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className="t-tab"
          role="tab"
          aria-selected={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** A switch on the transitions.dev toggle transition. */
export function Switch({
  on,
  onChange,
  label,
  disabled = false,
}: {
  on: boolean;
  onChange: (on: boolean) => void;
  label: string;
  disabled?: boolean;
}): ReactNode {
  const [touched, setTouched] = useState(false);
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      data-on={on ? "true" : "false"}
      className={cx("t-toggle", "switch", touched && "is-init")}
      disabled={disabled}
      onClick={() => {
        setTouched(true);
        onChange(!on);
      }}
    >
      <span className="t-toggle-thumb" />
    </button>
  );
}

/** A checkbox on the transitions.dev checkbox-check transition. The path length is fixed for the mark drawn here. */
export function Checkbox({
  checked,
  onChange,
  children,
  disabled = false,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  children: ReactNode;
  disabled?: boolean;
}): ReactNode {
  return (
    <label className="check-row">
      <button
        type="button"
        role="checkbox"
        aria-checked={checked}
        className={cx("t-check", "check")}
        disabled={disabled}
        style={{ ["--check-len" as string]: "14" }}
        onClick={() => onChange(!checked)}
      >
        <svg viewBox="0 0 10.1668 10.1668" aria-hidden="true">
          <path d="M1 5.52L3.92 9.17L9.17 1" />
        </svg>
      </button>
      <span>{children}</span>
    </label>
  );
}
