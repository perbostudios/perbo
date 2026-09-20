import { Socket, createServer } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { watchOutbound } from "./outbound.js";

/** A port nothing is listening on: taken, read, and given back. */
async function closedPort(): Promise<number> {
  const server = createServer();
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") reject(new Error("no port"));
      else resolve(address.port);
    });
  });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** Ask for a connection and wait for the refusal. */
async function askFor(port: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const socket = new Socket();
    socket.on("error", () => resolve());
    socket.on("connect", () => {
      socket.destroy();
      resolve();
    });
    socket.connect({ port, host: "127.0.0.1" });
  });
}

describe("watchOutbound", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sees a socket something asked to open", async () => {
    const port = await closedPort();
    const watch = watchOutbound();

    await askFor(port);

    expect(watch.destinations().join("\n")).toContain(`"port":${port}`);
  });

  it("sees a fetch, which a mocked one would never take to a socket", async () => {
    const port = await closedPort();
    const watch = watchOutbound();

    await fetch(`http://127.0.0.1:${port}/`).catch(() => undefined);

    expect(watch.destinations().some((asked) => asked.startsWith("fetch http://127.0.0.1:"))).toBe(
      true,
    );
  });

  it("says nothing when nothing was asked for", () => {
    expect(watchOutbound().destinations()).toEqual([]);
  });

  it("installs spies the caller's own restore puts back", () => {
    // The spies are this package's, the restore is the test file's. They only
    // meet if both resolve the same vitest, which is why vitest is a peer
    // dependency: a second instance would keep its own registry and leave a
    // spy on Socket.prototype for every test that ran afterwards.
    const original = Socket.prototype.connect;
    watchOutbound();
    expect(Socket.prototype.connect).not.toBe(original);

    vi.restoreAllMocks();

    expect(Socket.prototype.connect).toBe(original);
  });
});
