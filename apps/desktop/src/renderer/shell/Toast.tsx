import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { cx } from "@perbo/ui";

/** Transient confirmations — copied, saved, archived — on the transitions.dev toast transition. */
const ToastContext = createContext<(text: string) => void>(() => undefined);
export const useToast = (): ((text: string) => void) => useContext(ToastContext);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const show = useCallback((next: string): void => {
    setText(next);
    setOpen(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(false), 2600);
  }, []);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return (
    <ToastContext.Provider value={show}>
      {children}
      <div
        className={cx("toast", "t-toast", open && "is-open")}
        role="status"
        aria-live="polite"
        aria-hidden={!open}
      >
        {text}
      </div>
    </ToastContext.Provider>
  );
}
