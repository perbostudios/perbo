import { describe, expect, it } from "vitest";
import {
  ATTEMPTS_SUFFIX,
  ConfiguredFolderError,
  approachPath,
  attemptsFileName,
  attemptsPath,
  bundleManifestsDir,
  bundleObjectPath,
  bundleObjectsDir,
  bundleRoot,
  configPath,
  configuredFolder,
  contractPath,
  draftPath,
  principlesPath,
  stateDir,
  ticketFilePath,
  ticketIdOfAttemptsFile,
  ticketsDir,
} from "./store-layout.js";

describe("the paths under the store", () => {
  it("names each record as segments, so a caller joins them to the store it holds", () => {
    expect(configPath()).toEqual(["config.json"]);
    expect(principlesPath()).toEqual(["principles.md"]);
    expect(stateDir()).toEqual(["state"]);
    expect(ticketsDir()).toEqual(["tickets"]);
    expect(bundleRoot()).toEqual(["bundles"]);
    expect(bundleManifestsDir()).toEqual(["bundles", "bundles"]);
    expect(bundleObjectsDir()).toEqual(["bundles", "objects"]);
    expect(bundleObjectPath("a".repeat(64))).toEqual(["bundles", "objects", "a".repeat(64)]);
  });

  it("keys a ticket's four files by its key and its attempts by its id", () => {
    expect(ticketFilePath("PRB-118")).toEqual(["tickets", "PRB-118.json"]);
    expect(contractPath("PRB-118")).toEqual(["tickets", "PRB-118.contract.json"]);
    expect(draftPath("PRB-118")).toEqual(["tickets", "PRB-118.draft.json"]);
    expect(approachPath("PRB-118")).toEqual(["tickets", "PRB-118.approach.json"]);
    expect(attemptsPath("t_1")).toEqual(["state", "t_1.attempts.json"]);
  });
});

describe("the name of an attempts record", () => {
  it("inverts", () => {
    expect(attemptsFileName("t_1")).toBe(`t_1${ATTEMPTS_SUFFIX}`);
    expect(ticketIdOfAttemptsFile(attemptsFileName("t_1"))).toBe("t_1");
  });

  it("is not any other record the state directory holds", () => {
    // `state/` also holds stops, escapes and the endpoint, so a reader
    // listing the directory has to tell an attempts record from its neighbours.
    for (const name of [
      "t_1.stops.json",
      "t_1.escapes.json",
      "endpoint.json",
      "t_1.json",
      ATTEMPTS_SUFFIX,
      "",
    ])
      expect(ticketIdOfAttemptsFile(name), name).toBeNull();
  });
});

describe("the folder a config.json key names", () => {
  it("is the default where the file or the key is absent", () => {
    expect(configuredFolder(undefined, "specs")).toBe("specs");
    expect(configuredFolder(undefined, "adr")).toBe("docs/adr");
  });

  it("is the folder the repository named", () => {
    expect(configuredFolder("docs/specs", "specs")).toBe("docs/specs");
    expect(configuredFolder("adr", "adr")).toBe("adr");
  });

  it("refuses anything that is not a repository-relative folder, and says which key", () => {
    for (const named of ["../x", "/abs", "docs\\specs", "specs/", "", 3, null, ["specs"]]) {
      let thrown: unknown;
      try {
        configuredFolder(named, "specs");
      } catch (error) {
        thrown = error;
      }
      expect(thrown, String(named)).toBeInstanceOf(ConfiguredFolderError);
      expect((thrown as ConfiguredFolderError).key, String(named)).toBe("specs");
      expect((thrown as ConfiguredFolderError).message, String(named)).toMatch(
        /repository-relative folder/,
      );
    }
  });

  it("says what the key it refused names, so the sentence reads for either", () => {
    expect(() => configuredFolder(7, "specs")).toThrow(/It names where specs live/);
    expect(() => configuredFolder(7, "adr")).toThrow(/It names where ADRs live/);
  });
});
