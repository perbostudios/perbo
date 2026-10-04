// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { CONFIRM_TO_CHECK, REFUSED_NOT_AGAIN, ReadingFailedNotice } from "./ReadingFailed.js";

/**
 * The pop-up over a reading that did not run offers to confirm again, except
 * where the reading's model provider refused the request: the same request is
 * refused again, so it says so and offers nothing more.
 */
afterEach(cleanup);

describe("the pop-up over a reading that did not run", () => {
  it("offers to confirm again where the reading may run next time", () => {
    render(<ReadingFailedNotice error="No credential for Claude." onAcknowledge={() => undefined} />);
    expect(screen.getByText(CONFIRM_TO_CHECK)).toBeTruthy();
    expect(screen.queryByText(REFUSED_NOT_AGAIN)).toBeNull();
  });

  it("says checking again will not help where the provider refused the request", () => {
    render(
      <ReadingFailedNotice
        error="`perbo drift` was refused by the model provider: invalid_request_error."
        refused
        onAcknowledge={() => undefined}
      />,
    );
    expect(screen.getByText(REFUSED_NOT_AGAIN)).toBeTruthy();
    expect(screen.queryByText(CONFIRM_TO_CHECK)).toBeNull();
    expect(screen.getAllByRole("button").map((button) => button.textContent)).not.toContain("Confirm again");
  });
});
