import { useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  completeSymbol,
  markSpecSymbols,
  nearestSymbolNames,
  replaceSymbolName,
  specSymbolNames,
  symbolBeingTyped,
  symbolOptions,
} from "@perbo/planning/browser";
import { caretPoint } from "./caret.js";
import type { TextMarks } from "./change-marks.js";
import { SpecReading } from "./SpecReading.js";
import { TYPED_TEXT_MAX_CHARS, type ExportedName } from "../../shared/protocol.js";

/**
 * One section of the spec, with the `@Symbol` completion and marking over it
 * (D-015, SCP-321).
 *
 * Two views of the same text, because a spec is read far more often than it is
 * written. Until somebody types in it a section is shown as it reads
 * ({@link ./SpecReading.tsx}): headings as headings, bullets as bullets, a
 * requirement's id beside its line rather than in front of its first word.
 * Clicking or tabbing in opens the editor, and leaving it goes back.
 *
 * The editor itself is a plain textarea, because prose is written in one and
 * anything that intercepted typing would get in the way of writing it. The
 * marks are drawn behind it: a second copy of the same text, in the same box
 * and the same font, with each reference wrapped — so the textarea keeps every
 * behaviour a person expects of one and the marks land on the words. That only
 * holds while the two lay out identically, which is why the runs put the text
 * back together exactly and why the field grows to its content rather than
 * scrolling. It is also why the reading view is a view of its own and not a
 * prettier backdrop: a bullet, a chip and a heading all move the words, and a
 * caret has to land where the eye says it will.
 */

/** How many names the popup offers at once: enough to choose from, few enough to read. */
const OPTIONS = 6;
/** How many nearer names are offered for one the index does not hold. */
const NEAREST = 2;
/** The popup's width, in step with `.sym-pop` in the stylesheet, for the clamp. */
const POPUP_WIDTH = 340;
/** Keys that leave the caret somewhere else, so the reference under it may have changed. */
const MOVES_THE_CARET = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"];
/** Of those, the ones the open popup takes for itself. */
const CHOOSING = ["ArrowUp", "ArrowDown"];

/** The reference being completed: where it is, and which option is selected. */
interface Popup {
  query: string;
  /** Where the `@` is, and where the caret was: what an insertion replaces. */
  from: number;
  to: number;
  x: number;
  y: number;
  at: number;
}

export function SpecSection({
  field,
  name,
  hint,
  value,
  symbols,
  nodes,
  marks = null,
  onChange,
  onCommit,
  children,
}: {
  field: string;
  name: string;
  hint: string;
  value: string;
  /**
   * The repository's exported names, or null where there are none to check
   * against — the index is still being read, or this repository is not one it
   * describes. Null marks every reference as a reference and none as unknown,
   * because "not checked" is not "not found".
   */
  symbols: ExportedName[] | null;
  /**
   * Which nodes each requirement's criteria landed in, by requirement id, for
   * the Requirements section and nothing else.
   *
   * Beside the id it belongs to rather than in a table under the section: a
   * table would repeat every id to say one thing about it, a column of text to
   * read against a list of requirements already on the page (D-103).
   */
  nodes?: Map<string, string[]> | undefined;
  /**
   * The last change to this section, placed in `value`, for the reading view
   * to mark; null where there is none. Never shown while the section is being
   * edited: the editor shows the text as it is being typed, and marks over a
   * text that is moving would mark the wrong characters.
   */
  marks?: TextMarks | null;
  onChange: (value: string) => void;
  /** Save now, with this section's text, rather than waiting for the next render. */
  onCommit: (text?: string) => void;
  children?: React.ReactNode;
}) {
  const area = useRef<HTMLTextAreaElement | null>(null);
  const box = useRef<HTMLDivElement | null>(null);
  const [popup, setPopup] = useState<Popup | null>(null);
  // Which of the two views is showing. Reading until somebody asks to type,
  // and back to reading when they leave: the editor is the exception, not the
  // resting state of a document that is mostly read.
  const [editing, setEditing] = useState(false);
  // Where the caret goes after an insertion, which cannot be set until React
  // has put the new text in the textarea.
  const caret = useRef<number | null>(null);

  useLayoutEffect(() => {
    const element = area.current;
    if (element === null) return;
    if (caret.current !== null) {
      element.focus();
      element.setSelectionRange(caret.current, caret.current);
      caret.current = null;
    }
    // The marks are drawn behind the text, so the field is the height of the
    // text: a textarea that scrolled would slide every mark off its word.
    element.style.height = "auto";
    if (element.scrollHeight > 0) element.style.height = `${element.scrollHeight}px`;
    // `editing` as well as `value`: opening the editor mounts the textarea with
    // a caret waiting for it, and nothing about the text has changed.
  }, [value, editing]);

  // Held across renders: measuring one name against every exported name is the
  // most expensive thing on this path, and a section being typed in renders on
  // every keystroke over an index that has not moved.
  const known = useMemo(
    () => (symbols === null ? null : new Set(symbols.map((each) => each.name))),
    [symbols],
  );
  // De-duplicated: a name exported from two files is one name to offer, not
  // two identical buttons under the one key its text gives them.
  const names = useMemo(() => [...new Set((symbols ?? []).map((each) => each.name))], [symbols]);
  const options = popup === null ? [] : symbolOptions(popup.query, symbols ?? [], OPTIONS);

  /** Is a reference being typed at the caret? Asked again after every move. */
  const detect = (element: HTMLTextAreaElement): void => {
    const to = element.selectionStart;
    const being = symbolBeingTyped(element.value.slice(0, to));
    if (being === null || symbols === null) {
      setPopup(null);
      return;
    }
    const point = caretPoint(element, being.from);
    const width = box.current?.clientWidth ?? POPUP_WIDTH;
    setPopup({
      query: being.query,
      from: being.from,
      to,
      x: Math.max(0, Math.min(point.x, width - POPUP_WIDTH)),
      y: point.y + point.line,
      at: 0,
    });
  };

  /** Show the editor with the caret at `at`, held inside the text. */
  const open = (at: number): void => {
    caret.current = Math.max(0, Math.min(value.length, at));
    setEditing(true);
  };

  const insert = (chosen: string): void => {
    if (popup === null) return;
    const written = completeSymbol({ text: value, from: popup.from, to: popup.to, name: chosen });
    setPopup(null);
    if (written.text === value) {
      // Completing a reference that was already whole writes nothing, so
      // nothing re-renders and the effect that places the caret never runs. A
      // caret left armed here would be applied to the next change instead, and
      // the next character a person typed would land where this one meant to
      // go. It is placed now, because now is when it is wanted.
      area.current?.setSelectionRange(written.caret, written.caret);
      return;
    }
    caret.current = written.caret;
    onChange(written.text);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === "Escape" && popup !== null) {
      event.preventDefault();
      setPopup(null);
      return;
    }
    // With nothing to choose, every key is the textarea's own: Enter is a
    // newline and Tab leaves the field, as they are everywhere else.
    if (popup === null || options.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setPopup({ ...popup, at: (popup.at + 1) % options.length });
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setPopup({ ...popup, at: (popup.at - 1 + options.length) % options.length });
    } else if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      insert(options[popup.at]!.name);
    }
  };

  const unknown = useMemo(
    () => (known === null ? [] : specSymbolNames(value).filter((each) => !known.has(each))),
    [known, value],
  );
  // `unknown` is a new array every time `value` changes — every keystroke in
  // this section, not only one that touches a reference — so a memo keyed on
  // `unknown` itself would measure a name against every exported name on
  // every keystroke rather than once per name. Keyed on the joined names
  // instead: a primitive compares by value, so retyping the same set of
  // unknown names holds the previous measurement.
  const nearest = useMemo(
    () =>
      new Map(unknown.map((missing) => [missing, nearestSymbolNames(missing, names, NEAREST)])),
    [names, unknown.join(",")],
  );

  const placeholder = field === "requirements" ? "One per line, shortest first." : "Nothing yet.";
  return (
    <div className="spec-section">
      <div className="spec-h">
        <h3>{name}</h3>
        <span className="hint">{hint}</span>
      </div>
      {!editing ? (
        <SpecReading
          value={value}
          label={`Spec ${name}`}
          placeholder={placeholder}
          known={known}
          nodes={nodes}
          marks={marks}
          onOpen={open}
        />
      ) : (
        <div className="spec-field" ref={box}>
          <div className="spec-backdrop" aria-hidden="true">
            {markSpecSymbols(value).map((run, index) =>
              run.name === null ? (
                run.text
              ) : (
                <span
                  // The runs are positional: two references to the same name are
                  // two marks, and the index is what tells them apart.
                  key={index}
                  className={known !== null && !known.has(run.name) ? "sym sym--unknown" : "sym"}
                >
                  {run.text}
                </span>
              ),
            )}
            {/* A trailing newline collapses in a block, and the caret would sit a
                line above the mark it belongs to. */}
            {"\n"}
          </div>
          <textarea
            ref={area}
            className="spec-input"
            aria-label={`Spec ${name}`}
            spellCheck={false}
            rows={1}
            value={value}
            maxLength={TYPED_TEXT_MAX_CHARS}
            placeholder={placeholder}
            onChange={(event) => {
              onChange(event.target.value);
              detect(event.target);
            }}
            onClick={(event) => detect(event.currentTarget)}
            onKeyUp={(event) => {
              // An arrow the popup took moved the selection in it, not the caret
              // in the text: asking again here would answer the same reference
              // and put the selection back on the first name.
              if (popup !== null && options.length > 0 && CHOOSING.includes(event.key)) return;
              if (MOVES_THE_CARET.includes(event.key)) detect(event.currentTarget);
            }}
            onKeyDown={onKeyDown}
            onBlur={() => {
              setPopup(null);
              setEditing(false);
              onCommit();
            }}
          />
          {popup !== null && (
            <div
              className="sym-pop"
              role="listbox"
              aria-label="Exported symbols"
              style={{ left: `${popup.x}px`, top: `${popup.y}px` }}
            >
              <div className="sym-pop-head">
                <span>exported symbols</span>
                <span className="spacer" />
                <span>↵ insert</span>
              </div>
              {options.length > 0 ? (
                options.map((option, index) => (
                  <button
                    key={`${option.path}:${option.name}`}
                    type="button"
                    role="option"
                    aria-selected={index === popup.at}
                    className={index === popup.at ? "sym-opt active" : "sym-opt"}
                    // The field keeps the focus, so choosing with the mouse does
                    // not blur it and commit a half-typed reference on the way.
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => insert(option.name)}
                  >
                    <b>@{option.name}</b>
                    <i>{option.kind}</i>
                    <small>{option.path}</small>
                  </button>
                ))
              ) : (
                <div className="sym-empty">
                  No exported symbol matches “{popup.query}”. It will be marked until it resolves.
                </div>
              )}
            </div>
          )}
        </div>
      )}
      {unknown.map((missing) => (
        <div className="spec-warn" key={missing}>
          <span>@{missing} is not an exported symbol here, so the index cannot check it.</span>
          {(nearest.get(missing) ?? []).map((nearer) => (
            <button
              key={nearer}
              type="button"
              className="text-button small"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                // Every reference to it in this section, not the first: a name
                // written three times is wrong three times.
                const next = replaceSymbolName(value, missing, nearer);
                onChange(next);
                onCommit(next);
              }}
            >
              Use @{nearer}
            </button>
          ))}
        </div>
      ))}
      {children}
    </div>
  );
}
