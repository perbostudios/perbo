import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { EXIT_CODES } from "@perbo/contracts";
import { ProviderError, type Model } from "@perbo/model";
import { admitCommandLine } from "./admit.js";
import { exitForThrown, runCommandLine } from "../command-line/terminal.js";
import { UsageError } from "../usage-error.js";
import { storeDir } from "../store/tickets.js";
import { emptyRepository } from "../test-support/repository.js";
import { recordStreams } from "../test-support/streams.js";
import {
  REFUSING_TRANSPORTS,
  refusingModel,
  removeRefusingTransports,
} from "../test-support/refusing-transports.js";
import { CONTRACT_DRAFT_JSON_SCHEMA } from "@perbo/planning";

/**
 * Drafting a contract over a transport whose provider refuses the request
 * (`request_refused`), end to end: the draft is not produced, nothing is
 * written, the command exits `request_refused` rather than as bad input, and
 * its sentence says the request was refused and that trying again will not
 * help, offering admission by hand and never "try again".
 */

const scratch = mkdtempSync(join(tmpdir(), "perbo-admit-refused-"));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
  removeRefusingTransports();
});

const fetchIssue = () =>
  Promise.resolve({
    reference: "o/r#412",
    number: 412,
    title: "Users aren't getting the welcome email",
    body: "Signups since Tuesday get nothing.",
    url: "https://github.com/o/r/issues/412",
  });

async function admitWith(name: string, model: Model): Promise<{ thrown: unknown; repo: string }> {
  const repo = join(scratch, name);
  emptyRepository(repo);
  try {
    await runCommandLine(admitCommandLine, {
      argv: ["--repo", repo, "--from", "o/r#412"],
      streams: recordStreams(),
      cwd: repo,
      deps: { model, fetchIssue },
    });
  } catch (thrown) {
    return { thrown, repo };
  }
  throw new Error("the admission did not fail");
}

describe.each(REFUSING_TRANSPORTS)("a draft whose provider refuses the request, over %s", (transport) => {
  it("exits request_refused, says trying again will not help, and writes nothing", async () => {
    const { thrown, repo } = await admitWith(transport, refusingModel(transport, CONTRACT_DRAFT_JSON_SCHEMA));
    const exit = exitForThrown("admit", thrown);
    expect(exit.code).toBe(EXIT_CODES.request_refused);
    expect(exit.message).toContain("the draft was refused by the model provider");
    expect(exit.message).toContain("trying again will not help");
    expect(exit.message).toContain("Admit the work by hand");
    expect(exit.message).not.toMatch(/or try again/);
    expect(existsSync(join(storeDir(repo, null), "tickets"))).toBe(false);
  });
});

describe("a draft whose provider could not serve it", () => {
  it("stays bad input that may be tried again, so the kind is what decides", async () => {
    const unavailable: Model = {
      provider: "double",
      model_id: "scripted",
      turn: () => Promise.reject(new ProviderError("HTTP 529 after 3 attempts", 3, "provider_unavailable")),
    };
    const { thrown } = await admitWith("unavailable", unavailable);
    expect(thrown).toBeInstanceOf(UsageError);
    const exit = exitForThrown("admit", thrown);
    expect(exit.code).toBe(EXIT_CODES.usage_or_input_error);
    expect(exit.message).toMatch(/or try again$/);
  });
});
