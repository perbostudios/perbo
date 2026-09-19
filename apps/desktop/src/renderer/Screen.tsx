import {
  Children,
  createContext,
  isValidElement,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type { ChangeEvent, ReactNode, SelectHTMLAttributes } from "react";
import { Button, cx } from "@perbo/ui";
import { InkIcon } from "./InkIcon.js";

/** These primitives reproduce the repeated geometry in Perbo Screens, S1–S18. */
export function Brand({ wordmark = false }: { wordmark?: boolean }) {
  return (
    <span className="brand-lockup">
      <span className="brand-disc">
        <img src="./brand/perbo-mark.png" alt="Perbo" />
      </span>
      {wordmark && <span>perbo</span>}
    </span>
  );
}
export function ProgressDots({
  step,
  setup = false,
}: {
  step: number;
  setup?: boolean;
}) {
  return (
    <div
      className={cx("progress-dots", setup && "progress-dots--setup")}
      aria-label={`Step ${step} of 3`}
    >
      {[1, 2, 3].map((number) => (
        <span key={number} className={number <= step ? "filled" : ""} />
      ))}
    </div>
  );
}
/** Where page headers render: the window's top bar, beside the traffic lights, above the rail and the page. */
const HeaderSlot = createContext<{
  slot: HTMLElement | null;
  setSlot: (slot: HTMLElement | null) => void;
}>({ slot: null, setSlot: () => undefined });
/** Wraps the shell so pages anywhere beneath it can find the bar. */
export function HeaderSlotProvider({ children }: { children?: ReactNode }) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  return (
    <HeaderSlot.Provider value={{ slot, setSlot }}>
      {children}
    </HeaderSlot.Provider>
  );
}
export function TitleBar({ children }: { children?: ReactNode }) {
  const { setSlot } = useContext(HeaderSlot);
  return (
    <div className="titlebar">
      {children}
      <div className="titlebar-slot" ref={setSlot} />
    </div>
  );
}
export function PageHeader({
  title,
  subtitle,
  crumbs,
  children,
  wizard = false,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  /** Settings · Section · Sub-page (S6): the last crumb is where you are. */
  crumbs?: string[];
  children?: ReactNode;
  wizard?: boolean;
}) {
  const settingsTitle =
    typeof title === "string" && title.startsWith("Settings · ")
      ? title.slice("Settings · ".length)
      : null;
  const { slot } = useContext(HeaderSlot);
  const header = (
    <header className={cx("page-header", wizard && "page-header--wizard")}>
      <div
        className={cx(
          "header-title",
          (crumbs ||
            ["perbo", "Archive", "Settings"].includes(String(title))) &&
            "header-title--section",
        )}
      >
        {crumbs ? (
          crumbs.map((crumb, index) => (
            <span key={crumb + index} className="crumb">
              {index > 0 && (
                <span className="muted" aria-hidden="true">
                  ·
                </span>
              )}
              <span
                className={
                  index === crumbs.length - 1 ? "header-section" : undefined
                }
              >
                {crumb}
              </span>
            </span>
          ))
        ) : settingsTitle ? (
          <>
            Settings
            <span className="muted" aria-hidden="true">
              ·
            </span>
            <span className="header-section">{settingsTitle}</span>
          </>
        ) : (
          title
        )}
      </div>
      {subtitle && <span className="header-subtitle">{subtitle}</span>}
      <span className="spacer" />
      {children}
    </header>
  );
  // Until the top bar has mounted its slot (the first paint) the header stays in the page.
  return slot ? createPortal(header, slot) : header;
}
export function WizardHeader({
  step,
  children,
}: {
  step: number;
  children?: ReactNode;
}) {
  return (
    <PageHeader
      title="Create a task"
      subtitle={
        <>
          · <span>step {step} of 3</span>
        </>
      }
      wizard
    >
      <ProgressDots step={step} />
      {children}
    </PageHeader>
  );
}
export function PageFooter({ children }: { children: ReactNode }) {
  return <footer className="page-footer">{children}</footer>;
}
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
export function StageRing({
  stage,
  attention = false,
  complete = false,
}: {
  stage: number;
  attention?: boolean;
  complete?: boolean;
}) {
  const share = complete ? 100 : (stage / 6) * 100;
  return (
    <span
      className={cx(
        "stage-ring",
        attention && "stage-ring--attention",
        complete && "stage-ring--complete",
      )}
      aria-label={complete ? "Completed" : `Stage ${stage} of 6`}
      style={{
        background: `conic-gradient(${complete ? "var(--green)" : "var(--ink)"} 0 ${share}%,rgba(var(--ink-rgb),.16) ${share}% 100%)`,
      }}
    >
      <span />
    </span>
  );
}
/** A status line that swaps when its text changes, on the transitions.dev thinking-states transition. */
export function ThinkingStatus({
  text,
  className,
  live = true,
}: {
  text: string;
  className?: string;
  /** Shimmer while the work is live; a settled line stays still. */
  live?: boolean;
}) {
  const [lines, setLines] = useState<
    { key: number; text: string; phase: "enter" | "live" | "exit" }[]
  >([{ key: 0, text, phase: "live" }]);
  const counter = useRef(0);
  useEffect(() => {
    const current = lines.find((line) => line.phase !== "exit");
    if (current?.text === text) return;
    const key = ++counter.current;
    setLines((previous) => [
      ...previous.map((line) => ({ ...line, phase: "exit" as const })),
      { key, text, phase: "enter" },
    ]);
    const release = setTimeout(
      () =>
        setLines((previous) =>
          previous.map((line) =>
            line.key === key ? { ...line, phase: "live" } : line,
          ),
        ),
      50,
    );
    const drop = setTimeout(
      () =>
        setLines((previous) =>
          previous.filter((line) => line.phase !== "exit"),
        ),
      200,
    );
    return () => {
      clearTimeout(release);
      clearTimeout(drop);
    };
  }, [text]);
  const longest = lines.reduce(
    (best, line) => (line.text.length > best.length ? line.text : best),
    "",
  );
  return (
    <span
      className={cx(
        "t-think",
        "thinking",
        !live && "thinking--still",
        className,
      )}
      role="status"
    >
      <span className="t-think-sizer" aria-hidden="true">
        {longest}
      </span>
      {lines.map((line) => (
        <span
          key={line.key}
          className={cx(
            "t-think-text",
            line.phase === "exit" && "is-exit",
            line.phase === "enter" && "is-enter-start",
          )}
          data-text={line.text}
        >
          {line.text}
        </span>
      ))}
    </span>
  );
}
/** A number that pops its digits in when it changes (transitions.dev number pop-in). */
export function NumberPop({
  value,
  className,
}: {
  value: string | number;
  className?: string;
}) {
  const text = String(value);
  const previous = useRef(text);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (previous.current !== text) {
      previous.current = text;
      setTick((count) => count + 1);
    }
  }, [text]);
  const chars = text.split("");
  return (
    <span
      key={tick}
      className={cx("t-digit-group", tick > 0 && "is-animating", className)}
    >
      {chars.map((char, index) => (
        <span
          key={index}
          className="t-digit"
          data-stagger={
            index === chars.length - 2
              ? "1"
              : index === chars.length - 1
                ? "2"
                : undefined
          }
        >
          {char}
        </span>
      ))}
    </span>
  );
}
/** The inked mark arriving on a finished screen (transitions.dev success check; the mark is a bitmap, so no path draws). */
export function SuccessMark({
  name,
  size,
}: {
  name: Parameters<typeof InkIcon>[0]["name"];
  size: number;
}) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <span
      className="t-success-check"
      data-state={shown ? "in" : "out"}
      aria-hidden="true"
    >
      <InkIcon name={name} size={size} />
    </span>
  );
}
export function WaitScreen({
  step,
  title,
  description,
  status,
  onCancel,
}: {
  step: number;
  title: string;
  description: string;
  status: string;
  onCancel: () => void;
}) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <section
      className="screen wait-screen"
      data-screen={step === 1 ? "s8" : "s10"}
    >
      <WizardHeader step={step} />
      <div className="wait-body">
        <InkIcon name="dots" size={52} className="waiting-dots" />
        <div className={cx("t-stagger", shown && "is-shown")}>
          <h1 className="t-stagger-line t-stagger-line--1">{title}</h1>
          <p className="t-stagger-line t-stagger-line--2">{description}</p>
        </div>
        <div className="wait-progress">
          <div className="progress-track indeterminate">
            <span />
          </div>
          <div className="wait-status">
            <ThinkingStatus text={status} />
          </div>
        </div>
      </div>
      <PageFooter>
        <span className="small muted">
          You can leave this page. Your work stays on this machine.
        </span>
        <span className="spacer" />
        <Button onClick={onCancel}>Cancel</Button>
      </PageFooter>
    </section>
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
export function Rename({
  title,
  onSave,
  size = 15,
  open = false,
  onOpenChange,
}: {
  title: string;
  onSave: (title: string) => Promise<unknown>;
  size?: number;
  /** Opened from outside, for the rename shortcut. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [editing, setEditing] = useState(open),
    [value, setValue] = useState(title),
    [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!editing) setValue(title);
  }, [title, editing]);
  useEffect(() => {
    if (open) setEditing(true);
  }, [open]);
  const close = (): void => {
    setEditing(false);
    onOpenChange?.(false);
  };
  const save = (): void => {
    if (value.trim())
      void onSave(value.trim())
        .then(close)
        .catch((error) => setError(String(error)));
  };
  return (
    <span className="rename" onClick={(event) => event.stopPropagation()}>
      {editing ? (
        <>
          <input
            autoFocus
            aria-label="Task name"
            value={value}
            maxLength={200}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") save();
              if (event.key === "Escape") {
                close();
                setValue(title);
              }
            }}
          />
          <button className="text-button small" onClick={save}>
            Save
          </button>
          <span className="small muted">renaming · ↵ to save</span>
        </>
      ) : (
        <>
          <span>{title}</span>
          <IconButton
            icon="locked"
            size={size}
            label="Rename this task"
            onClick={() => {
              setEditing(true);
              onOpenChange?.(true);
            }}
          />
        </>
      )}
      {error && <span role="alert">{error}</span>}
    </span>
  );
}
export function FactList({
  rows,
  className = "",
}: {
  rows: [string, ReactNode][];
  className?: string;
}) {
  return (
    <dl className={cx("fact-list", className)}>
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
export function SectionLabel({ children }: { children: ReactNode }) {
  return <h2 className="section-label">{children}</h2>;
}
/** Elapsed time of something that started at `since`, ticking once a second while it runs. */
export function useElapsed(
  since: string | null | undefined,
  running: boolean,
): string | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  if (!since) return null;
  const seconds = Math.max(0, Math.round((now - Date.parse(since)) / 1000));
  return seconds >= 60
    ? `${Math.floor(seconds / 60)}m ${seconds % 60}s`
    : `${seconds}s`;
}
