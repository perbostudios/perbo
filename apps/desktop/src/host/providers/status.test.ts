import { describe, expect, it } from "vitest";
import { LOGIN_COMMANDS, openLogin, probeProviders } from "./status.js";
import type { Execute } from "../repository/git.js";
import type { HostIO } from "../service.js";
import type { ProcessResult } from "../process.js";

const ok = (stdout: string, stderr = ""): ProcessResult => ({
  code: 0,
  stdout,
  stderr,
  cancelled: false,
});
/** Answers each provider's status command, or throws where its CLI is not installed. */
function probe(answers: Record<string, ProcessResult | "missing">): {
  execute: Execute;
  calls: { binary: string; args: readonly string[] }[];
} {
  const calls: { binary: string; args: readonly string[] }[] = [];
  return {
    calls,
    execute: (binary, args) => {
      calls.push({ binary, args });
      const answer = answers[binary];
      if (!answer || answer === "missing") throw new Error("command not found");
      return Promise.resolve(answer);
    },
  };
}
const signedIn = {
  claude: ok(JSON.stringify({ loggedIn: true, authMethod: "oauth" })),
  codex: ok("Signed in with ChatGPT"),
};
const provider = (rows: Awaited<ReturnType<typeof probeProviders>>, id: string) =>
  rows.find((row) => row.id === id)!;

describe("probeProviders", () => {
  it("asks each provider's own CLI, in the profile directory", async () => {
    const w = probe(signedIn);
    await probeProviders(w.execute, "/profile");
    expect(w.calls).toEqual([
      { binary: "claude", args: ["auth", "status", "--json"] },
      { binary: "codex", args: ["login", "status"] },
    ]);
  });

  it("reads a Claude subscription from its own account of how it signed in", async () => {
    const rows = await probeProviders(probe(signedIn).execute, "/profile");
    expect(provider(rows, "claude")).toMatchObject({
      installed: true,
      authenticated: true,
      detail: "Signed in with your subscription",
    });
  });

  it("says a credential the CLI manages where it is not a subscription", async () => {
    const rows = await probeProviders(
      probe({ ...signedIn, claude: ok(JSON.stringify({ loggedIn: true, authMethod: "apiKey" })) })
        .execute,
      "/profile",
    );
    expect(provider(rows, "claude").detail).toBe("Signed in · credential managed by the CLI");
  });

  it("asks a person to sign in where the CLI is installed and has not", async () => {
    const rows = await probeProviders(
      probe({ ...signedIn, claude: ok(JSON.stringify({ loggedIn: false })) }).execute,
      "/profile",
    );
    expect(provider(rows, "claude")).toMatchObject({
      installed: true,
      authenticated: false,
      detail: "Installed · sign in through your terminal, then refresh",
    });
  });

  it("reads Codex from its exit status, and its plan from what it wrote", async () => {
    const rows = await probeProviders(probe(signedIn).execute, "/profile");
    expect(provider(rows, "codex")).toMatchObject({
      authenticated: true,
      detail: "Signed in with your subscription",
    });
    const metered = await probeProviders(
      probe({ ...signedIn, codex: ok("Signed in with an API key") }).execute,
      "/profile",
    );
    expect(provider(metered, "codex").detail).toBe("Signed in · credential managed by the CLI");
  });

  it("says a CLI that is not installed is not installed", async () => {
    const rows = await probeProviders(probe({ codex: signedIn.codex }).execute, "/profile");
    expect(provider(rows, "claude")).toMatchObject({
      installed: false,
      authenticated: false,
      detail: "CLI unavailable. Install it, sign in, then refresh.",
    });
  });

  it("reads the Anthropic key from the environment it was given", async () => {
    const w = probe(signedIn);
    const without = await probeProviders(w.execute, "/profile", {});
    expect(provider(without, "anthropic")).toMatchObject({
      authenticated: false,
      detail: "No ANTHROPIC_API_KEY in the app environment",
    });
    const with_ = await probeProviders(w.execute, "/profile", { ANTHROPIC_API_KEY: "sk-ant-x" });
    expect(provider(with_, "anthropic")).toMatchObject({
      authenticated: true,
      detail: "Environment credential available · metered API usage",
    });
  });

  it("names the command a person runs to sign each one in", async () => {
    const rows = await probeProviders(probe(signedIn).execute, "/profile");
    expect(provider(rows, "claude").loginCommand).toBe("claude auth login");
    expect(provider(rows, "codex").loginCommand).toBe("codex login");
  });
});

describe("openLogin", () => {
  it("runs the provider's own fixed command in the person's terminal", async () => {
    const opened: (readonly string[])[] = [];
    const io = {
      openTerminal: (command: readonly string[]) => {
        opened.push(command);
        return Promise.resolve();
      },
    } as HostIO;
    expect(await openLogin(io, "codex")).toBeNull();
    expect(opened).toEqual([LOGIN_COMMANDS.codex]);
  });

  it("says what to run where this host has no terminal to open", async () => {
    await expect(openLogin({} as HostIO, "claude")).rejects.toThrow(
      "Run claude auth login in your terminal, then refresh the connection.",
    );
  });
});
