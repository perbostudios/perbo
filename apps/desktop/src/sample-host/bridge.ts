import { RequestSchema } from "../shared/protocol.js";
import type { DesktopBridge } from "../shared/protocol.js";
import { answer } from "./handlers.js";
import { subscribe } from "./records.js";

/**
 * The adapter the renderer is driven against with no native host behind it:
 * the tests under jsdom, and the development preview in a browser
 * ([D-120](../../../../docs/11-open-decisions.md)).
 *
 * It answers the same Request table the host answers, over sample records held
 * in memory and in this browser's own storage. No process, credential,
 * repository or network operation is reachable from here, so a screen shows
 * only what a reply carried, exactly as it does against the host.
 */
export const sampleBridge: DesktopBridge = {
  request: async (request) => answer(RequestSchema.parse(request) as typeof request),
  subscribe,
};
