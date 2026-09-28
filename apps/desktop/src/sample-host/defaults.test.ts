// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { sampleBridge } from "./bridge.js";
import { snapshot } from "./records.js";

/**
 * The sample host answers as the host does (D-093): a planning with no ticket
 * yet takes the defaults for new tasks as they are now, so a change under
 * Connections reaches it, and the ticket it admits runs on them.
 */
const before = structuredClone(snapshot.settings);
afterEach(() => {
  snapshot.settings = structuredClone(before);
});

describe("the sample's defaults for new tasks", () => {
  it("reach a planning opened before they changed, and the ticket it admits", async () => {
    const repoId = snapshot.repositories[0]!.id;
    const opened = await sampleBridge.request({ kind: "editingOpen", target: { kind: "fresh", repoId } });
    await sampleBridge.request({
      kind: "saveSettings",
      settings: {
        ...snapshot.settings,
        executorProvider: "claude-cli",
        executorModel: "claude-opus-5-5",
        reviewerProvider: "claude-cli",
        reviewerModel: "claude-opus-5-5",
        draftingProvider: "claude-cli",
        architectProvider: "claude-cli",
        architectModel: "claude-fable-5-1",
      },
    });
    const read = await sampleBridge.request({ kind: "editingRead", id: opened.id });
    expect(read.form.models).toMatchObject({
      executorModel: "claude-opus-5-5",
      reviewerModel: "claude-opus-5-5",
      architectProvider: "claude-cli",
      architectModel: "claude-fable-5-1",
    });
    await sampleBridge.request({
      kind: "specSave",
      id: opened.id,
      repoId,
      title: "Greeting mail",
      sections: { outcome: "New users receive a greeting email.", requirements: "- A signup queues one email.", no_gos: "", rabbit_holes: "", notes: "" },
      base: { title: "", sections: { outcome: "", requirements: "", no_gos: "", rabbit_holes: "", notes: "" } },
    });
    const saved = await sampleBridge.request({ kind: "editingRead", id: opened.id });
    await sampleBridge.request({
      kind: "editingSubmit",
      id: opened.id,
      revision: saved.revision,
      operationId: crypto.randomUUID(),
      intent: "generate",
    });
    let key: string | null = null;
    for (let count = 0; count < 300 && key === null; count++) {
      key = (await sampleBridge.request({ kind: "editingRead", id: opened.id })).key;
      if (key === null) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(key).not.toBeNull();
    expect(snapshot.taskModels?.[`${repoId}:${key}`]).toMatchObject({ executorModel: "claude-opus-5-5", reviewerModel: "claude-opus-5-5" });
  }, 20_000);
});
