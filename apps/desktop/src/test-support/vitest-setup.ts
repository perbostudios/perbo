import { configure } from "@testing-library/react";

/**
 * How long a `findBy*` or a `waitFor` has to see what it is waiting for.
 *
 * Testing Library's own default is one second, which is a render budget rather
 * than a wait: these tests mount the whole app and run their files beside each
 * other, so a second is a measure of how loaded the machine is and not of
 * whether the app did what was asked. A test that waits longer for something
 * that never arrives still fails — later, and only when it was going to fail
 * anyway — while one waiting on a busy machine now passes for the same reason
 * it passes on an idle one.
 *
 * Floored well under `testTimeout`, so a genuine miss is still reported as the
 * assertion that missed rather than as the whole test timing out.
 */
configure({ asyncUtilTimeout: 5_000 });

/**
 * The adapter every renderer test is driven against: one sample host in the
 * slot `window.perbo`, filled before a test file's own imports run, so
 * `renderer/data.ts` reads it exactly as it reads preload's in Electron.
 *
 * A Node-environment suite has no window and loads none of this: the sample
 * host reads `location` and `localStorage` when it loads.
 */
if (typeof window !== "undefined") {
  const { sampleBridge } = await import("../sample-host/bridge.js");
  window.perbo = sampleBridge;
}
