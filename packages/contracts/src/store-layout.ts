import { DEFAULT_ADR_FOLDER, DEFAULT_SPEC_FOLDER, isRepositoryRelativeFolder } from "./paths.js";

/**
 * Where the records another process reads live inside a repository's store.
 *
 * The CLI writes `<repo>/.perbo`, the runner appends to it and the desktop
 * reads it, so the name of each file is a fact three packages share and none
 * of them owns. Stated here once, as **segments relative to the store**, so a
 * caller joins them to whatever it holds the store as: `join(store, ...p)`,
 * `join(repo, STORE_DIRNAME, ...p)` or the desktop's
 * `safePath(repo, STORE_DIRNAME, ...p)`. There is no `node:path` here, which
 * is what lets the renderer load this module as well.
 *
 * `docs/03-domain-and-event-model.md` "Store layout" is the prose home: the
 * tree it draws is what this declares.
 *
 * A record only one package reads is not here. The CLI keeps `runs/`,
 * `reviews/`, `verdicts.json`, `index.json` and the other `state/` files with
 * the module that owns each, and takes only the directory name from here.
 */
export type StorePath = readonly string[];

/** The store's directory name inside a repository. */
export const STORE_DIRNAME = ".perbo";

/** Where a run's own records go, keyed by ticket id rather than by key. */
export const STATE_DIR = "state";

export const ATTEMPTS_SUFFIX = ".attempts.json";

/** The product-principles ratchet a person writes and the brief carries (D-065). */
export const PRINCIPLES_FILENAME = "principles.md";

/** Inside the bundle root, laid out by the runner's BundleStore. */
export const BUNDLE_MANIFESTS_DIR = "bundles";
export const BUNDLE_OBJECTS_DIR = "objects";

const TICKETS_DIR = "tickets";
const BUNDLE_ROOT_DIR = "bundles";
const CONFIG_FILENAME = "config.json";

export function attemptsFileName(ticketId: string): string {
  return `${ticketId}${ATTEMPTS_SUFFIX}`;
}

/**
 * The ticket id an attempts record is keyed by, or null where the name is
 * some other record: `state/` also holds stops, escapes and the endpoint, and
 * a reader listing the directory tells them apart by this and nothing else.
 */
export function ticketIdOfAttemptsFile(name: string): string | null {
  if (!name.endsWith(ATTEMPTS_SUFFIX)) return null;
  const id = name.slice(0, -ATTEMPTS_SUFFIX.length);
  return id.length === 0 || id.includes(".") ? null : id;
}

export function configPath(): StorePath {
  return [CONFIG_FILENAME];
}

export function principlesPath(): StorePath {
  return [PRINCIPLES_FILENAME];
}

export function stateDir(): StorePath {
  return [STATE_DIR];
}

export function attemptsPath(ticketId: string): StorePath {
  return [STATE_DIR, attemptsFileName(ticketId)];
}

export function ticketsDir(): StorePath {
  return [TICKETS_DIR];
}

/** The Ticket itself: state, history, delivery, scheduling. */
export function ticketFilePath(key: string): StorePath {
  return [TICKETS_DIR, `${key}.json`];
}

/** The PlanContract, immutable once approved. */
export function contractPath(key: string): StorePath {
  return [TICKETS_DIR, `${key}.contract.json`];
}

/** The draft: proposal, model provenance, edit history. */
export function draftPath(key: string): StorePath {
  return [TICKETS_DIR, `${key}.draft.json`];
}

/** The approach a graphed plan or a spec with No-Gos was admitted with. */
export function approachPath(key: string): StorePath {
  return [TICKETS_DIR, `${key}.approach.json`];
}

export function bundleRoot(): StorePath {
  return [BUNDLE_ROOT_DIR];
}

export function bundleManifestsDir(): StorePath {
  return [BUNDLE_ROOT_DIR, BUNDLE_MANIFESTS_DIR];
}

export function bundleObjectsDir(): StorePath {
  return [BUNDLE_ROOT_DIR, BUNDLE_OBJECTS_DIR];
}

export function bundleObjectPath(sha256: string): StorePath {
  return [BUNDLE_ROOT_DIR, BUNDLE_OBJECTS_DIR, sha256];
}

/** The `config.json` keys naming where specs and ADRs live (D-103). */
export const SPEC_FOLDER_CONFIG_KEY = "specs";
export const ADR_FOLDER_CONFIG_KEY = "adr";
export type FolderConfigKey = typeof SPEC_FOLDER_CONFIG_KEY | typeof ADR_FOLDER_CONFIG_KEY;

const FOLDER_CONFIG: Record<
  FolderConfigKey,
  { default: string; names: string; example: string }
> = {
  [SPEC_FOLDER_CONFIG_KEY]: {
    default: DEFAULT_SPEC_FOLDER,
    names: "specs live",
    example: '"specs" or "docs/specs"',
  },
  [ADR_FOLDER_CONFIG_KEY]: {
    default: DEFAULT_ADR_FOLDER,
    names: "ADRs live",
    example: '"docs/adr" or "adr"',
  },
};

/**
 * A `config.json` key that does not name a repository-relative folder.
 *
 * The message completes a sentence its thrower begins with the file it read,
 * because the CLI, the runner and the desktop each name that file their own
 * way and the rest of the sentence is the same for all three.
 */
export class ConfiguredFolderError extends Error {
  readonly key: FolderConfigKey;

  constructor(key: FolderConfigKey, message: string) {
    super(message);
    this.name = "ConfiguredFolderError";
    this.key = key;
  }
}

/**
 * The folder one `config.json` key names, or its default (D-103).
 *
 * `named` is the key's raw value, `undefined` where the file or the key is
 * absent — the caller reads the configuration, this judges the value, so a
 * repository that names a folder no reader would accept is refused the same
 * way wherever it is read.
 */
export function configuredFolder(named: unknown, key: FolderConfigKey): string {
  const { default: fallback, names, example } = FOLDER_CONFIG[key];
  if (named === undefined) return fallback;
  if (typeof named !== "string" || !isRepositoryRelativeFolder(named))
    throw new ConfiguredFolderError(
      key,
      `sets '${key}' to something that is not a repository-relative folder. ` +
        `It names where ${names}, for example ${example}`,
    );
  return named;
}
