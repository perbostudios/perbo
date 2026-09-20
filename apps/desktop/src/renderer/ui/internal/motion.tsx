import { useEffect, useRef, useState } from "react";
import { cx } from "./cx.js";
import { InkIcon } from "./InkIcon.js";

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
