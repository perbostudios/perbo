import { fireEvent } from "@testing-library/react";

/**
 * Type `text` at the end of a field as a browser does: a field with a
 * `maxlength` takes characters until it is full and no more. jsdom sets a
 * value whatever its length, so the browser's rule is applied here, read from
 * the field's own `maxLength`; a field without one takes the text whole, and
 * whatever its own `onChange` does with it is the field's.
 */
export function typeInto(field: HTMLInputElement | HTMLTextAreaElement, text: string): void {
  const room = field.maxLength < 0 ? text.length : Math.max(0, field.maxLength - field.value.length);
  fireEvent.change(field, { target: { value: field.value + text.slice(0, room) } });
}
