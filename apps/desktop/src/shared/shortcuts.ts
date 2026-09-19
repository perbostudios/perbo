import { z } from "zod";

/**
 * Keyboard bindings, per machine (S6G). A binding is written as its modifiers
 * and one key, `Meta+Shift+K`; `Meta` is ⌘ on macOS and Ctrl elsewhere, so one
 * saved binding reads the same on both.
 */
export const SHORTCUT_ACTIONS = [
  "plan",
  "home",
  "archive",
  "settings",
  "search",
  "archiveSearch",
  "create",
  "rename",
  "output",
  "stop",
  "decisionNext",
  "decisionBack",
  "decisionSend",
  "approve",
  "openPullRequest",
] as const;
export const ShortcutActionSchema = z.enum(SHORTCUT_ACTIONS);
export type ShortcutAction = z.infer<typeof ShortcutActionSchema>;

const KEY =
  /^(?:[A-Z0-9]|Enter|Escape|Space|Backspace|Tab|ArrowLeft|ArrowRight|ArrowUp|ArrowDown|[.,/;'\-=[\]`\\])$/;
export const BindingSchema = z
  .string()
  .max(60)
  .refine((value) => parseBinding(value) !== null, "Not a keyboard binding");
export type Binding = string;

export interface ParsedBinding {
  meta: boolean;
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
  key: string;
}

export function parseBinding(value: string): ParsedBinding | null {
  const parts = value.split("+");
  const key = parts.pop() ?? "";
  if (!KEY.test(key)) return null;
  const parsed = { meta: false, shift: false, alt: false, ctrl: false, key };
  for (const part of parts) {
    if (part === "Meta") parsed.meta = true;
    else if (part === "Shift") parsed.shift = true;
    else if (part === "Alt") parsed.alt = true;
    else if (part === "Ctrl") parsed.ctrl = true;
    else return null;
  }
  return parsed;
}

export function formatBinding(parsed: ParsedBinding): Binding {
  return [
    parsed.ctrl && "Ctrl",
    parsed.alt && "Alt",
    parsed.shift && "Shift",
    parsed.meta && "Meta",
    parsed.key,
  ]
    .filter(Boolean)
    .join("+");
}

/** Normalises a keyboard event into a binding, or null for a bare modifier press. */
export function bindingFromEvent(event: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  code?: string;
}): Binding | null {
  let key = event.key;
  if (["Meta", "Control", "Alt", "Shift", "Dead"].includes(key)) return null;
  if (key === " ") key = "Space";
  else if (key.length === 1) {
    // A shifted digit arrives as its symbol; the physical key is the binding.
    const digit = /^Digit(\d)$/.exec(event.code ?? "");
    key = digit ? digit[1]! : key.toUpperCase();
  }
  if (!KEY.test(key)) return null;
  // The primary modifier is one binding on both platforms.
  const primary = isMac() ? event.metaKey : event.ctrlKey;
  const secondary = isMac() ? event.ctrlKey : event.metaKey;
  return formatBinding({
    meta: primary,
    ctrl: secondary,
    alt: event.altKey,
    shift: event.shiftKey,
    key,
  });
}

let platformMac: boolean | null = null;
export function isMac(): boolean {
  if (platformMac === null)
    platformMac =
      typeof navigator !== "undefined" &&
      /Mac|iPhone|iPad/.test(navigator.platform ?? "");
  return platformMac;
}
export function setPlatformForTests(mac: boolean | null): void {
  platformMac = mac;
}

const SYMBOLS: Record<string, string> = {
  Enter: "↵",
  Escape: "esc",
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
  Space: "space",
  Backspace: "⌫",
  Tab: "⇥",
};

/** How the Shortcuts page prints a binding: ⌘ ⇧ ⌥ ⌃ on a Mac, words elsewhere. */
export function displayBinding(value: Binding): string[] {
  const parsed = parseBinding(value);
  if (!parsed) return [value];
  const mac = isMac();
  return [
    parsed.ctrl && (mac ? "⌃" : "Meta"),
    parsed.alt && (mac ? "⌥" : "Alt"),
    parsed.shift && (mac ? "⇧" : "Shift"),
    parsed.meta && (mac ? "⌘" : "Ctrl"),
    SYMBOLS[parsed.key] ?? parsed.key,
  ].filter((part): part is string => typeof part === "string");
}

export interface ShortcutDefinition {
  action: ShortcutAction;
  label: string;
  group: "move" | "ticket" | "decisions" | "fixed";
  binding: Binding;
  /** The two that spend money or write to the repository stay as drawn. */
  fixed?: boolean;
}

export const SHORTCUT_GROUPS: {
  id: ShortcutDefinition["group"];
  title: string;
  detail: string;
}[] = [
  { id: "move", title: "Move around", detail: "the sidebar, in order" },
  {
    id: "ticket",
    title: "A ticket",
    detail: "⌘N anywhere; the rest from inside a ticket",
  },
  {
    id: "decisions",
    title: "Decisions",
    detail: "while the loop is waiting on you",
  },
  {
    id: "fixed",
    title: "Fixed",
    detail: "these two spend money or write to your repository",
  },
];

export const DEFAULT_SHORTCUTS: readonly ShortcutDefinition[] = [
  {
    action: "plan",
    label: "Create — opens the picker",
    group: "move",
    binding: "Meta+1",
  },
  { action: "home", label: "Home", group: "move", binding: "Meta+2" },
  { action: "archive", label: "Archive", group: "move", binding: "Meta+3" },
  {
    action: "settings",
    label: "Settings — opens the drop-up",
    group: "move",
    binding: "Meta+4",
  },
  {
    action: "search",
    label: "Search running tickets",
    group: "move",
    binding: "Meta+K",
  },
  {
    action: "archiveSearch",
    label: "Search the archive",
    group: "move",
    binding: "Shift+Meta+K",
  },
  {
    action: "create",
    label: "Create a task",
    group: "ticket",
    binding: "Meta+N",
  },
  {
    action: "rename",
    label: "Rename the ticket you are on",
    group: "ticket",
    binding: "Meta+E",
  },
  {
    action: "output",
    label: "Watch the agents’ own output",
    group: "ticket",
    binding: "Meta+L",
  },
  {
    action: "stop",
    label: "Call off the run",
    group: "ticket",
    binding: "Meta+.",
  },
  {
    action: "decisionNext",
    label: "Answer and go to the next question",
    group: "decisions",
    binding: "Enter",
  },
  {
    action: "decisionBack",
    label: "Back one question",
    group: "decisions",
    binding: "Meta+ArrowLeft",
  },
  {
    action: "decisionSend",
    label: "Send every answer",
    group: "decisions",
    binding: "Meta+Enter",
  },
  {
    action: "approve",
    label: "Approve the contract",
    group: "fixed",
    binding: "Shift+Meta+Enter",
    fixed: true,
  },
  {
    action: "openPullRequest",
    label: "Open the pull request",
    group: "fixed",
    binding: "Shift+Meta+M",
    fixed: true,
  },
];

export type ShortcutMap = Partial<Record<ShortcutAction, Binding>>;

/** The effective binding of every action: the saved override, or the default. */
export function effectiveShortcuts(
  overrides: ShortcutMap,
): Record<ShortcutAction, Binding> {
  const result = {} as Record<ShortcutAction, Binding>;
  for (const definition of DEFAULT_SHORTCUTS)
    result[definition.action] = definition.fixed
      ? definition.binding
      : (overrides[definition.action] ?? definition.binding);
  return result;
}

/** The action already holding a binding, if any — a conflict is refused and named, never taken silently. */
export function conflictFor(
  overrides: ShortcutMap,
  action: ShortcutAction,
  binding: Binding,
): ShortcutDefinition | null {
  const effective = effectiveShortcuts(overrides);
  for (const definition of DEFAULT_SHORTCUTS)
    if (
      definition.action !== action &&
      effective[definition.action] === binding
    )
      return definition;
  return null;
}

export function actionForBinding(
  overrides: ShortcutMap,
  binding: Binding,
): ShortcutAction | null {
  const effective = effectiveShortcuts(overrides);
  for (const definition of DEFAULT_SHORTCUTS)
    if (effective[definition.action] === binding) return definition.action;
  return null;
}
