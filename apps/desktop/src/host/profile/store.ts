import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { replaceFile } from "@perbo/workspace";
import { EditingSessionSchema, SettingsSchema, TaskModelsSchema } from "../../shared/protocol.js";

/** A repository the person connected, as the profile records it. */
export const RegisteredRepositorySchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  path: z.string(),
});
export type RegisteredRepository = z.infer<typeof RegisteredRepositorySchema>;

export const JobSchema = z.object({
  id: z.string().uuid(),
  repoId: z.string().uuid(),
  key: z.string().nullable(),
  kind: z.string(),
  label: z.string(),
  state: z.enum([
    "running",
    "stopping",
    "completed",
    "failed",
    "cancelled",
    "interrupted",
  ]),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  log: z.string(),
  error: z.string().nullable(),
  resultKey: z.string().nullable(),
  result: z.unknown(),
  editing: z
    .object({ sessionId: z.string().uuid(), operationId: z.string().uuid() })
    .optional(),
});

/** Everything this host keeps between launches, in one file. */
export const ProfileStateSchema = z.object({
  version: z.literal(1),
  settings: SettingsSchema,
  repositories: z.array(RegisteredRepositorySchema),
  jobs: z.array(JobSchema),
  titles: z.record(z.string(), z.string()).default({}),
  taskModels: z.record(z.string(), TaskModelsSchema).default({}),
  /** Completed tickets filed away from Home by hand (S4), as `repoId:key`. */
  archived: z.array(z.string()).default([]),
  /** Whether the tickets already finished before this preference existed have been filed. */
  archivedSeeded: z.boolean().default(false),
  editingSessions: z.array(EditingSessionSchema).default([]),
});
export type ProfileState = z.infer<typeof ProfileStateSchema>;

/**
 * The person's own `workspace.json`: their settings, the repositories they
 * connected, the journal of what has run and the preferences beside each
 * ticket. It is this machine's record and never a repository's.
 */
export class Profile {
  /** The moment the record last reached disk, which paces a running job's progress writes. */
  lastSave = 0;

  readonly path: string;
  state: ProfileState;

  private constructor(path: string, state: ProfileState) {
    this.path = path;
    this.state = state;
  }

  /**
   * Read the profile, or start one. A profile written before the four
   * notification moments keeps what its one switch said, and a job the app
   * closed on is marked interrupted: the command outlived the window or died
   * with it, and either way its outcome is in the CLI's records rather than
   * here.
   */
  static open(dataDirectory: string): Profile {
    mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
    const path = join(dataDirectory, "workspace.json");
    const stored = existsSync(path)
      ? z.record(z.string(), z.unknown()).parse(JSON.parse(readFileSync(path, "utf8")))
      : null;
    const state: ProfileState = stored
      ? ProfileStateSchema.parse(stored)
      : {
          version: 1,
          settings: SettingsSchema.parse({}),
          repositories: [],
          jobs: [],
          titles: {},
          taskModels: {},
          archived: [],
          archivedSeeded: true,
          editingSessions: [],
        };
    const legacy = z
      .looseObject({
        notifications: z.boolean().optional(),
        notifyOn: z.unknown().optional(),
      })
      .safeParse(stored?.["settings"] ?? {});
    if (
      legacy.success &&
      legacy.data.notifyOn === undefined &&
      legacy.data.notifications === false
    )
      state.settings.notifyOn = {
        decision: false,
        review: false,
        ceiling: false,
        stage: false,
      };
    for (const job of state.jobs)
      if (job.state === "running" || job.state === "stopping") {
        job.state = "interrupted";
        job.error =
          "Perbo closed before the command reported an outcome. Refresh the ticket from its CLI records before starting again.";
        job.endedAt = new Date().toISOString();
      }
    return new Profile(path, state);
  }

  /** Replaced whole, so a crash leaves the record as it was rather than half of it. */
  save(): void {
    replaceFile(this.path, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    this.lastSave = Date.now();
  }
}
