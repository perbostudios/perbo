import { Children, isValidElement, useEffect, useRef, useState } from "react";
import type { ChangeEvent, ReactNode, SelectHTMLAttributes } from "react";
import { cx } from "./cx.js";

/** A listbox behind the native select's interface: `value`, `onChange(event.target.value)`, `<option>` children. Opens on the menu-dropdown transition; the OS menu never appears. */
export function Dropdown({
  value,
  onChange,
  disabled = false,
  children,
  id,
  className,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement>) {
  const options = Children.toArray(children).flatMap((child) =>
    isValidElement<{
      value?: string | number;
      disabled?: boolean;
      children?: ReactNode;
    }>(child) && child.type === "option"
      ? [
          {
            value: String(
              child.props.value ??
                (typeof child.props.children === "string"
                  ? child.props.children
                  : ""),
            ),
            label: child.props.children,
            disabled: Boolean(child.props.disabled),
          },
        ]
      : [],
  );
  const [open, setOpen] = useState(false),
    [closing, setClosing] = useState(false),
    [active, setActive] = useState(0);
  const root = useRef<HTMLSpanElement>(null);
  const closeClock = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (closeClock.current) clearTimeout(closeClock.current);
    },
    [],
  );
  const current = String(value ?? "");
  const selected = options.find((option) => option.value === current);
  const close = (): void => {
    if (!open) return;
    setOpen(false);
    setClosing(true);
    if (closeClock.current) clearTimeout(closeClock.current);
    closeClock.current = setTimeout(() => setClosing(false), 150);
  };
  const choose = (next: string): void => {
    close();
    if (next !== current)
      onChange?.({
        target: { value: next },
      } as unknown as ChangeEvent<HTMLSelectElement>);
  };
  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent): void => {
      if (!root.current?.contains(event.target as Node)) close();
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
    // `close` reads this render's `open`, which is what the listener is keyed on.
  }, [open]);
  const enabled = options
    .map((option, index) => (option.disabled ? -1 : index))
    .filter((index) => index >= 0);
  const step = (direction: 1 | -1): void => {
    if (!enabled.length) return;
    const position = enabled.indexOf(active);
    setActive(
      enabled[(position + direction + enabled.length) % enabled.length]!,
    );
  };
  return (
    <span ref={root} className={cx("dropdown", className)}>
      <button
        type="button"
        role="combobox"
        id={id}
        className="dropdown-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={id ? id + "-listbox" : undefined}
        aria-label={rest["aria-label"]}
        aria-describedby={rest["aria-describedby"]}
        disabled={disabled}
        onClick={() => {
          if (open) close();
          else {
            setActive(
              Math.max(
                0,
                options.findIndex((option) => option.value === current),
              ),
            );
            setOpen(true);
          }
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape" && open) {
            event.preventDefault();
            close();
          } else if (["ArrowDown", "ArrowUp"].includes(event.key)) {
            event.preventDefault();
            if (!open) {
              setActive(
                Math.max(
                  0,
                  options.findIndex((option) => option.value === current),
                ),
              );
              setOpen(true);
            } else step(event.key === "ArrowDown" ? 1 : -1);
          } else if (event.key === "Enter" && open) {
            event.preventDefault();
            const option = options[active];
            if (option && !option.disabled) choose(option.value);
          }
        }}
      >
        <span className="dropdown-label">{selected?.label ?? current}</span>
        <img src="./brand/dropdown.svg" alt="" aria-hidden="true" />
      </button>
      {(open || closing) && (
        <ul
          id={id ? id + "-listbox" : undefined}
          role="listbox"
          className={cx(
            "dropdown-menu",
            "t-dropdown",
            open && "is-open",
            closing && "is-closing",
          )}
          data-origin="top-left"
        >
          {options.map((option, index) => (
            <li
              key={option.value + index}
              role="option"
              aria-selected={option.value === current}
              aria-disabled={option.disabled || undefined}
              className={cx("dropdown-option", index === active && "active")}
              onMouseEnter={() => setActive(index)}
              onClick={() => {
                if (!option.disabled) choose(option.value);
              }}
            >
              {option.label}
            </li>
          ))}
        </ul>
      )}
    </span>
  );
}
