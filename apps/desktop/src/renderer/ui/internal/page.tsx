import { createContext, useContext, useState } from "react";
import { createPortal } from "react-dom";
import type { ReactNode } from "react";
import { cx } from "./cx.js";

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
export function PageFooter({ children }: { children: ReactNode }) {
  return <footer className="page-footer">{children}</footer>;
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
