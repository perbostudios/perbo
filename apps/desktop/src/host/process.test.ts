import { afterEach, describe, expect, it, vi } from "vitest";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  LINE_CHAR_CAP,
  childEnvironment,
  forgetRegistryPath,
  installLocations,
  registryPath,
  redact,
  requireSuccess,
  runProcess,
  searchPath,
  startLineProcess,
} from "./process.js";
import type { LineProcess } from "./process.js";

const windows = process.platform === "win32";
/** Two spellings of one Windows directory compare equal. */
const normalise = (entry: string): string =>
  entry.toLowerCase().replace(/[\\/]+$/, "");
afterEach(() => forgetRegistryPath());

describe("searchPath", () => {
  it("keeps the first source's ordering and drops later duplicates", () => {
    const merged = searchPath([
      ["/first", "/second"],
      ["/second", "/third"],
    ]).split(delimiter);
    expect(merged).toEqual(["/first", "/second", "/third"]);
  });

  it("drops empty entries and unwraps quoted ones", () => {
    expect(searchPath([["", "  ", '"/quoted"']]).split(delimiter)).toEqual([
      "/quoted",
    ]);
  });

  it.runIf(windows)(
    "treats Windows entries as the same directory whatever their case or trailing separator",
    () => {
      const merged = searchPath([
        ["C:\\Program Files\\GitHub CLI\\"],
        ["c:\\program files\\github cli"],
      ]).split(delimiter);
      expect(merged).toEqual(["C:\\Program Files\\GitHub CLI\\"]);
    },
  );
});

describe("installLocations", () => {
  it.runIf(windows)("names where the CLIs this app spawns install on Windows", () => {
    const found = installLocations(
      { ProgramFiles: "C:\\Program Files", APPDATA: "C:\\A", LOCALAPPDATA: "C:\\L" },
      "C:\\home",
    );
    expect(found).toContain(join("C:\\Program Files", "GitHub CLI"));
    expect(found).toContain(join("C:\\A", "npm"));
    expect(found).toContain(join("C:\\home", ".local", "bin"));
    expect(found).not.toContain("/opt/homebrew/bin");
  });

  it.runIf(!windows)("keeps the Homebrew and user prefixes a Finder launch misses", () => {
    const found = installLocations({}, "/home/one");
    expect(found).toEqual([
      "/home/one/.local/bin",
      "/opt/homebrew/bin",
      "/usr/local/bin",
    ]);
  });
});

describe("registryPath", () => {
  it.runIf(!windows)("asks nothing outside Windows", () => {
    expect(registryPath()).toEqual([]);
  });

  it.runIf(windows)("reads the machine and user PATH and expands what it stores", () => {
    const entries = registryPath();
    expect(entries.length).toBeGreaterThan(0);
    // REG_EXPAND_SZ keeps `%SystemRoot%\system32` unexpanded on disk; a child
    // process searching PATH cannot use it in that form.
    expect(entries.some((entry) => entry.includes("%"))).toBe(false);
    expect(
      entries.some((entry) => /windows[\\/]system32/i.test(entry)),
    ).toBe(true);
  });
});

describe("childEnvironment", () => {
  it("leaves exactly one spelling of PATH, which is what a child reads", () => {
    const env = childEnvironment();
    expect(Object.keys(env).filter((key) => /^path$/i.test(key))).toEqual([
      "PATH",
    ]);
  });

  it("puts the install locations ahead of the launch environment", () => {
    const entries = childEnvironment().PATH!.split(delimiter);
    expect(entries[0]).toBe(installLocations()[0]);
  });

  it("keeps every directory the app launched with", () => {
    const entries = new Set(
      childEnvironment()
        .PATH!.split(delimiter)
        .map((entry) => (windows ? entry.toLowerCase() : entry)),
    );
    for (const entry of (process.env.PATH ?? "").split(delimiter)) {
      if (!entry.trim()) continue;
      expect(entries.has(windows ? entry.toLowerCase() : entry)).toBe(true);
    }
  });

  it.runIf(windows)(
    "reaches a directory the registry gained after this process started",
    () => {
      // The bug this covers: an app launched from Explorer holds the PATH of
      // that moment, so a CLI installed afterwards — `gh`, and then a run that
      // publishes refuses to start — is invisible to every child it spawns
      // until the person signs out. Here the launch PATH is stripped back to
      // the one directory Windows always has, standing in for that snapshot.
      vi.stubEnv("PATH", "C:\\Windows\\system32");
      try {
        const entries = childEnvironment()
          .PATH!.split(delimiter)
          .map(normalise);
        const registry = registryPath();
        expect(registry.length).toBeGreaterThan(1);
        for (const entry of registry) expect(entries).toContain(normalise(entry));
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );

  it.runIf(windows)("reads one PATH however the launch environment spelled it", () => {
    // Explorer hands the app `Path`; reading `env.PATH` off the spread object
    // would miss it, and both keys reaching a child leaves the choice to spawn.
    const env = childEnvironment({ Path: "C:\\Only\\Here" });
    expect(Object.keys(env).filter((key) => /^path$/i.test(key))).toEqual([
      "PATH",
    ]);
    expect(env.PATH!.split(delimiter).map(normalise)).toContain(
      normalise("C:\\Only\\Here"),
    );
  });

  it("carries the extra entries and clears what Electron would leak", () => {
    const env = childEnvironment({ ELECTRON_RUN_AS_NODE: "1", MARK: "kept" });
    expect(env.MARK).toBe("kept");
    expect(env.NO_COLOR).toBe("1");
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
  });
});

/**
 * The long-lived child the interview needs (D-102, SCP-313): stdin stays open
 * and is written a line at a time, stdout comes back a line at a time, and a
 * stop ends stdin and then signals the process group, as the runner does.
 */
describe("requireSuccess", () => {
  const result = { code: 0, stdout: "out", stderr: "", cancelled: false };
  it("hands back what the command wrote", () => {
    expect(requireSuccess(result)).toBe("out");
  });

  it("says a stopped command was stopped, rather than reporting its code as a failure", () => {
    expect(() => requireSuccess({ ...result, code: 130, cancelled: true })).toThrow(
      "Command stopped. Refresh the ticket to read its recorded outcome.",
    );
  });

  it("carries the command's own words, and falls back to its code where it wrote none", () => {
    expect(() => requireSuccess({ ...result, code: 2, stderr: "  no such ticket\n" })).toThrow(
      "no such ticket",
    );
    expect(() => requireSuccess({ ...result, code: 2, stderr: "  \n" })).toThrow(
      "CLI exited with code 2.",
    );
  });
});

describe("startLineProcess", () => {
  const script = (body: string): string[] => ["-e", body];
  const lines = async (
    args: string[],
    drive: (child: LineProcess) => void,
  ): Promise<{ out: string[]; stderr: string[]; close: { code: number; stopped: boolean } }> => {
    const out: string[] = [];
    const stderr: string[] = [];
    return new Promise((resolve, reject) => {
      const child = startLineProcess(process.execPath, args, {
        cwd: process.cwd(),
        onLine: (line) => out.push(line),
        onStderr: (text) => stderr.push(text),
        onClose: (close) => resolve({ out, stderr, close }),
        onError: reject,
      });
      drive(child);
    });
  };

  it("writes a line to stdin and reads one back, whole, however the child chunked it", async () => {
    const { out, close } = await lines(
      script(
        "const rl=require('node:readline').createInterface({input:process.stdin});" +
          "rl.on('line',l=>{process.stdout.write('{\"echo\":');process.stdout.write(l);process.stdout.write('}\\n');});" +
          "rl.on('close',()=>process.exit(0));",
      ),
      (child) => {
        child.write('{"type":"turn","text":"one"}\n');
        child.write('{"type":"turn","text":"two"}\n');
        setTimeout(() => child.stop(), 200);
      },
    );
    expect(out).toEqual([
      '{"echo":{"type":"turn","text":"one"}}',
      '{"echo":{"type":"turn","text":"two"}}',
    ]);
    expect(close.stopped).toBe(true);
  });

  it("ends stdin first, so a child that leaves on its own is never signalled", async () => {
    const { out, close } = await lines(
      script(
        "const rl=require('node:readline').createInterface({input:process.stdin});" +
          "rl.on('close',()=>{process.stdout.write('closed\\n');process.exit(7);});",
      ),
      (child) => child.stop(),
    );
    expect(out).toEqual(["closed"]);
    expect(close.code).toBe(7);
  });

  it("redacts a credential on the child's stderr rather than streaming it", async () => {
    const { stderr } = await lines(
      script("process.stderr.write('starting with sk-ant-abcdefghijklmnop\\n');process.exit(0);"),
      () => undefined,
    );
    expect(stderr.join("")).toContain("[redacted]");
    expect(stderr.join("")).not.toContain("sk-ant-abcdefghijklmnop");
  });

  it("takes a line the child has not read yet: a full buffer is not a closed stdin", async () => {
    const taken: boolean[] = [];
    const { out, close } = await lines(
      // A child that reads nothing until it is told to, so the writes below
      // fill the pipe's buffer rather than draining through it.
      script(
        "setTimeout(()=>{const rl=require('node:readline').createInterface({input:process.stdin});" +
          "let n=0;rl.on('line',()=>{n+=1;});rl.on('close',()=>{process.stdout.write(`read ${n}\n`);" +
          "process.exit(0);});},300);",
      ),
      (child) => {
        for (let each = 0; each < 4; each++) taken.push(child.write(`${"x".repeat(200_000)}\n`));
        setTimeout(() => child.stop(), 1200);
      },
    );
    expect(taken).toEqual([true, true, true, true]);
    expect(out).toEqual(["read 4"]);
    expect(close.code).toBe(0);
  });

  it("says so rather than growing without a bound when one line never ends", async () => {
    const { out, stderr, close } = await lines(
      script(
        // No `process.exit` after a megabyte: a pipe write that large is not
        // finished when it returns, and exiting would truncate what is being
        // measured.
        `process.stdout.write('x'.repeat(${String(LINE_CHAR_CAP + 16)}));process.stdout.write('\\ntail\\n');`,
      ),
      () => undefined,
    );
    expect(out).toEqual(["tail"]);
    expect(stderr.join("")).toContain("longer than");
    expect(close.code).toBe(0);
  });
});

describe("desktop process supervision", () => {
  it("redacts inherited credentials and token forms", () => {
    expect(
      redact("secret-value-123 sk-ant-abcdefghijklmnop", {
        API_KEY: "secret-value-123",
      }),
    ).toBe("[redacted] [redacted]");
  });
  it("redacts the longer environment value first, so a shorter one leaves no tail", () => {
    // Two bindings where one value is a prefix of the other. Replaced in the
    // order the environment happens to list them, the prefix goes first and
    // the rest of the longer value stands in the log.
    expect(
      redact("x=ghp_prefixed_value_long", {
        GH_TOKEN: "ghp_prefix",
        MY_SECRET: "ghp_prefixed_value_long",
      }),
    ).not.toContain("ed_value_long");
  });

  it("redacts a value bound to any credential-shaped name", () => {
    const cleaned = redact("key=openai-value-not-vendor-shaped db=hunter2-pricing-value", {
      OPENAI_KEY: "openai-value-not-vendor-shaped",
      DB_PASSWD: "hunter2-pricing-value",
    });
    expect(cleaned).not.toContain("openai-value-not-vendor-shaped");
    expect(cleaned).not.toContain("hunter2-pricing-value");
  });

  it("redacts the credential forms the shared detector knows", () => {
    // Nothing from this machine's environment: these four are recognised by
    // their own shape, which is the half a list of variable names cannot reach.
    const pem =
      "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----";
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const cleaned = redact(
      `${pem}\n${jwt}\npostgres://u:s3cr3tpass@db/x\nAKIAIOSFODNN7EXAMPLE\n`,
      {},
    );
    expect(cleaned).not.toContain("MIIEvQIBADANBgkqhkiG9w0BAQEFAASC");
    expect(cleaned).not.toContain(jwt);
    expect(cleaned).not.toContain("s3cr3tpass");
    expect(cleaned).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("redacts a provider key quoted in a line, bound to nothing", () => {
    // The shapes an agent prints while telling a person to rotate a key. The
    // detector knows the two vendor prefixes; the rule here knows `sk-` on its
    // own, which is too broad for a detector that rewrites findings.
    const cleaned = redact(
      "rotate sk-ant-api03-0123456789abcdefghij, ghp_scp200sentineltokenvalue and sk-0123456789abcdef",
      {},
    );
    expect(cleaned).not.toContain("sk-ant-api03-0123456789abcdefghij");
    expect(cleaned).not.toContain("ghp_scp200sentineltokenvalue");
    expect(cleaned).not.toContain("sk-0123456789abcdef");
  });

  it("does not stream a partial credential split across stderr chunks", async () => {
    const observed: string[] = [];
    const result = await runProcess(
      process.execPath,
      [
        "-e",
        "process.stderr.write('secret-'); setTimeout(() => process.stderr.write('value-123\\n'), 40)",
      ],
      {
        cwd: tmpdir(),
        env: { ...process.env, API_KEY: "secret-value-123" },
        onOutput: (line) => observed.push(line),
      },
    );
    expect(observed.join("")).not.toContain("secret-");
    expect(result.stderr).toContain("[redacted]");
  });
  it("cancels an active subprocess and reports cancellation", async () => {
    const controller = new AbortController();
    const pending = runProcess(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { cwd: tmpdir(), signal: controller.signal },
    );
    await delay(50);
    controller.abort();
    const result = await pending;
    expect(result.cancelled).toBe(true);
    expect(result.code).not.toBe(0);
  });
});