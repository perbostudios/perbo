import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  BundleIdSchema,
  RunBundleSchema,
  bundleId,
  computeReplayability,
  type ArtifactRef,
  type ContextItem,
  type RunBundle,
  type RunBundleKind,
  type SecretIndex,
} from "@perbo/contracts";

/**
 * Immutable run bundles, written locally (SCP-048, ADR-0013 as amended, ADR-0026).
 *
 * A run not recorded is lost permanently and cannot be backfilled — which is
 * why this is Stage 2 work and not "later". Everything else here can be
 * recomputed from its inputs; this is the inputs.
 *
 * Two properties do the work:
 *
 * **Content-addressed.** Large artifacts — the transcript, the diff, the
 * verdict — are stored under `sha256(bytes)` and referenced by hash. Two
 * attempts producing the same diff store it once, and a bundle that references
 * bytes it no longer has says `retained: false` rather than pretending.
 *
 * **Local.** The store is a directory on this machine.
 */

export interface BundleStoreOptions {
  root: string;
  /**
   * Whether to keep the bytes the model actually saw. This single choice is
   * what decides `re_executable` versus `forensic`, so it is a parameter rather
   * than a constant (ADR-0026's tier is a policy per task class).
   */
  retainContext: boolean;
}

export interface WriteBundleRequest {
  kind: RunBundleKind;
  subject_id: string;
  ticket_id: string;
  inputs: Record<string, string | number | boolean | null>;
  context_manifest: ContextItem[];
  versions: RunBundle["versions"];
  usage: RunBundle["usage"];
  artifacts: Array<{ name: string; media_type: string; body: string }>;
  errors: Array<{ kind: string; message: string }>;
  transitions: RunBundle["transitions"];
  retention: RunBundle["retention"];
  secrets: SecretIndex;
  excluded_paths: string[];
  deterministic: boolean;
  model_version_pinned: boolean;
  now: Date;
}

export class BundleStore {
  private readonly root: string;
  private readonly retainContext: boolean;

  constructor(options: BundleStoreOptions) {
    this.root = resolve(options.root);
    this.retainContext = options.retainContext;
    mkdirSync(join(this.root, "objects"), { recursive: true });
    mkdirSync(join(this.root, "bundles"), { recursive: true });
  }

  private putObject(body: string): { sha256: string; bytes: number } {
    const buffer = Buffer.from(body, "utf8");
    const sha256 = createHash("sha256").update(buffer).digest("hex");
    if (this.retainContext) {
      const path = join(this.root, "objects", sha256);
      if (!existsSync(path)) writeFileSync(path, buffer);
    }
    return { sha256, bytes: buffer.length };
  }

  readObject(sha256: string): string | null {
    const path = join(this.root, "objects", sha256);
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  }

  /**
   * Write one bundle. Everything is redacted against the attempt's secret index
   * on the way in, and the count of redactions is recorded — a bundle claiming
   * zero is making a claim, and one that omits the field is not.
   */
  write(request: WriteBundleRequest): { bundle: RunBundle; path: string } {
    let redactions = 0;
    const artifacts: ArtifactRef[] = request.artifacts.map((artifact) => {
      const redacted = request.secrets.redact(artifact.body);
      redactions += redacted.redactions;
      const stored = this.putObject(redacted.text);
      return {
        name: artifact.name,
        sha256: stored.sha256,
        bytes: stored.bytes,
        media_type: artifact.media_type,
        retained: this.retainContext,
      };
    });

    const replay = computeReplayability({
      deterministic: request.deterministic,
      context_bytes_retained: this.retainContext && artifacts.length > 0,
      model_version_pinned: request.model_version_pinned,
    });

    const bundle = RunBundleSchema.parse({
      schema_version: 1,
      bundle_id: bundleId(`${request.kind}|${request.subject_id}|${request.now.toISOString()}`),
      kind: request.kind,
      created_at: request.now.toISOString(),
      subject_id: request.subject_id,
      ticket_id: request.ticket_id,
      inputs: request.inputs,
      context_manifest: request.context_manifest,
      versions: request.versions,
      usage: request.usage,
      artifacts,
      errors: request.errors,
      transitions: request.transitions,
      retention: request.retention,
      redaction: {
        secret_content_sha256: request.secrets.entries.map((entry) => entry.content_sha256),
        secret_value_count: request.secrets.size,
        redactions,
        excluded_paths: request.excluded_paths,
      },
      replayability: replay.tier,
      replayability_reason: replay.reason,
    } satisfies RunBundle);

    const path = join(this.root, "bundles", `${bundle.bundle_id}.json`);
    if (existsSync(path)) {
      // Immutable: a bundle id is a hash of what produced it, so a collision is
      // the same run written twice and rewriting it would be the one edit this
      // record must never accept.
      return { bundle, path };
    }
    writeFileSync(path, `${JSON.stringify(bundle, null, 2)}\n`);
    return { bundle, path };
  }

  /**
   * One bundle by id, or null where the store does not hold it.
   *
   * The id is validated before it reaches the path: it is `bundle_` and sixteen
   * hex digits and nothing else, so a value that came from a command line can
   * name a file in this directory and never one outside it.
   */
  read(bundleId: string): RunBundle | null {
    if (!BundleIdSchema.safeParse(bundleId).success) return null;
    const path = join(this.root, "bundles", `${bundleId}.json`);
    if (!existsSync(path)) return null;
    return RunBundleSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  }

  list(): RunBundle[] {
    const dir = join(this.root, "bundles");
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => RunBundleSchema.parse(JSON.parse(readFileSync(join(dir, name), "utf8"))))
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  /** Every bundle for one ticket, in order. This is what "replayable" means locally. */
  forTicket(ticketId: string): RunBundle[] {
    return this.list().filter((bundle) => bundle.ticket_id === ticketId);
  }
}
