import { z } from "zod";
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
