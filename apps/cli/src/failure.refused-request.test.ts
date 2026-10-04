import { describe, expect, it } from "vitest";
import { EXIT_CODES } from "@perbo/contracts";
import { ProviderError } from "@perbo/model";
import { describeFailure } from "./failure.js";

/**
 * A command whose model provider refused the request Perbo sent — `drift`,
 * `options`, any that lets the error through — exits `request_refused`, which
 * a caller such as the desktop does not run again, and says why in a sentence
 * that offers no second try. A provider that could not serve stays exit 3.
 */
describe("a refused request leaving a command", () => {
  it("exits request_refused, saying trying again will not help", () => {
    const failure = describeFailure(
      "drift",
      new ProviderError("invalid_json_schema: Missing 'requirement_id'", 1, "request_refused"),
    );
    expect(failure.code).toBe(EXIT_CODES.request_refused);
    expect(failure.message).toBe(
      "`perbo drift` was refused by the model provider: invalid_json_schema: Missing 'requirement_id'. " +
        "The provider refuses the request Perbo sends as it is built, so trying again will not help.",
    );
  });

  it("leaves a provider that could not serve as a command that did not complete", () => {
    const failure = describeFailure("options", new ProviderError("HTTP 529", 3, "provider_unavailable"));
    expect(failure.code).toBe(EXIT_CODES.did_not_complete);
  });
});
