import { describe, expect, it } from "vitest";
import { createRoutes, requestKinds, route, type HostModules, type RouteContext } from "./routes.js";
import type { Request, RequestHandlers } from "../shared/protocol.js";

/**
 * The table alone, with nothing behind it: every entry is a function, and what
 * is asserted here is which kinds it answers rather than what each one does.
 */
const routes = (): RequestHandlers<RouteContext> =>
  createRoutes({} as unknown as HostModules);

describe("the capability map", () => {
  it("answers every Request kind the protocol declares, and nothing else", () => {
    expect(Object.keys(routes()).sort()).toEqual(requestKinds());
  });

  it("holds a function for each of them", () => {
    for (const [kind, handler] of Object.entries(routes()))
      expect(typeof handler, kind).toBe("function");
  });

  it("cannot be added to after it is built", () => {
    const table = routes() as Record<string, unknown>;
    expect(() => {
      table["shell"] = () => undefined;
    }).toThrow();
    expect(Object.hasOwn(table, "shell")).toBe(false);
  });

  it("refuses a kind the table does not hold, including an Object.prototype name", async () => {
    const table = routes();
    for (const kind of ["toString", "constructor", "hasOwnProperty", "shell", "__proto__"])
      await expect(
        route(table, { kind } as unknown as Request, {}),
      ).rejects.toThrow(`Unsupported request ${kind}`);
  });

  it("answers a kind it does hold", async () => {
    const answered: string[] = [];
    const table = {
      ...routes(),
      snapshot: () => {
        answered.push("snapshot");
        return { tasks: [] } as never;
      },
    } as RequestHandlers<RouteContext>;
    await route(table, { kind: "snapshot" }, {});
    expect(answered).toEqual(["snapshot"]);
  });

  it("hands the handler the request and the session that started it", async () => {
    const seen: { request: Request; context: RouteContext }[] = [];
    const table = {
      ...routes(),
      editingRead: ((request, context) => {
        seen.push({ request, context });
        return {} as never;
      }) as RequestHandlers<RouteContext>["editingRead"],
    } as RequestHandlers<RouteContext>;
    const owner = {
      sessionId: "80000000-0000-4000-8000-000000000001",
      operationId: "80000000-0000-4000-8000-000000000002",
    };
    await route(table, { kind: "editingRead", id: owner.sessionId }, { owner });
    expect(seen[0]?.request).toEqual({ kind: "editingRead", id: owner.sessionId });
    expect(seen[0]?.context.owner).toBe(owner);
  });
});
