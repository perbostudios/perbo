import {
  applyGraphEdit,
  EMPTY_SPEC_TEXT,
  impactReport,
  mergeSpecText,
  readSpecSections,
  renderSpec,
  specSlug,
} from "@perbo/planning/browser";
import { isNeverReadPath } from "@perbo/contracts/paths";
import type { GraphEdit } from "@perbo/contracts/graph-edit";
import { openDrafts } from "../shared/contract-editing.js";
import type { EditingOwner } from "../shared/contract-editing.js";
import { archiveCsv, archiveRows } from "../shared/archive.js";
import { isLive } from "../shared/jobs.js";
import { HELP_LINKS } from "../shared/protocol.js";
import type { ProviderModel, ReplyMap, Request, RequestHandlers } from "../shared/protocol.js";
import {
  applyDraft,
  approved,
  at,
  criteriaText,
  decisionsAnswered,
  detail,
  draftFromSpec,
  editing,
  editingRecords,
  emit,
  graphLog,
  graphView,
  initial,
  interviewStatus,
  job,
  nameSpecFromTurn,
  newSampleTicket,
  plans,
  SAMPLE_INDEX,
  sampleFiles,
  sampleManifests,
  sampleRead,
  sampleSummary,
  sampleInterviews,
  sampleTranscript,
  saveSpec,
  snapshot,
  specFiles,
  specView,
  standingFor,
  startSampleInterview,
  ticketRow,
  undoGraphEditAt,
  writeGraphEdit,
  answerSampleTurn,
  askingChanged,
  askingOf,
  converse,
} from "./records.js";

/**
 * The sample host's answer to every Request kind, one entry each (D-100's
 * protocol is the whole list). The table is `RequestHandlers`, so a kind the
 * protocol declares and this does not answer, a key it does not declare, and a
 * reply that is not the kind's own are each a compile error rather than
 * something a conformance run has to catch.
 *
 * The context a handler is given is the editing session that started the
 * request, where one did: a job it opens is recorded against that session so
 * the planning it came from settles with it.
 */
export const handlers: RequestHandlers<EditingOwner | undefined> = {
  editingOpen: (request) => editing.open(request.target, request.legacy),
  editingRead: (request) => editing.read(request.id),
  drafts: () => openDrafts(editingRecords()),
  editingSave: (request) => editing.save(request.id, request.revision, request.repoId, request.form),
  editingSubmit: (request) =>
    editing.submit(request.id, request.revision, request.operationId, request.intent),
  editingStop: (request) => editing.stop(request.id),
  explorerList: (request) => {
    const tracked = sampleFiles(request.repoId);
    const files = tracked.filter((path) => !isNeverReadPath(path)).sort();
    return { files, hidden: tracked.length - files.length, standing: standingFor(request.repoId) };
  },
  explorerRead: (request) => sampleRead(request.repoId, request.path),
  graphRead: (request) => graphView(request.repoId, request.key),
  graphEdit: (request) =>
    job(
      request.kind,
      request.repoId,
      request.key,
      (job) => {
        const edit: GraphEdit = request.edit;
        writeGraphEdit(
          request.key,
          (state) =>
            applyGraphEdit(
              state,
              edit,
              graphLog(request.key)
                .flatMap((each) => each.keys)
                .filter((key) => key.startsWith("node:") || key.startsWith("criterion:"))
                .map((key) => key.slice(key.indexOf(":") + 1)),
            ),
          null,
        );
        job.resultKey = request.key;
      },
      120,
    ),
  graphUndo: (request) =>
    job(
      request.kind,
      request.repoId,
      request.key,
      (job) => {
        undoGraphEditAt(request.key, request.edit);
        job.resultKey = request.key;
      },
      120,
    ),
  explorerMark: (request) =>
    editing.mark(request.id, request.revision, request.path, request.mark, request.always),
  explorerUndo: (request) => editing.undo(request.id, request.revision, request.edit),
  editingDiscard: (request) => {
    const session = editing.discard(request.id, request.revision);
    sampleInterviews.delete(request.id);
    emit({ kind: "interview", sessionId: request.id, running: false, entry: null, asking: askingOf(request.id) });
    return session;
  },
  interviewStart: (request) => {
    const session = editing.read(request.id);
    if (session.repoId !== request.repoId)
      throw new Error("This planning belongs to another repository.");
    return startSampleInterview(request.id);
  },
  interviewTurn: (request) => {
    if (!sampleInterviews.has(request.id)) {
      nameSpecFromTurn(request.id, request.text);
      startSampleInterview(request.id);
    }
    converse(request.id, { kind: "turn", text: request.text });
    editing.answerAsking(request.id, request.text);
    askingChanged(request.id);
    const text = request.text;
    setTimeout(() => answerSampleTurn(request.id, text), 120);
    return interviewStatus(request.id);
  },
  interviewStop: (request) => {
    sampleInterviews.delete(request.id);
    emit({ kind: "interview", sessionId: request.id, running: false, entry: null, asking: askingOf(request.id) });
    converse(request.id, { kind: "note", text: "The interview ended: you stopped it." });
    return interviewStatus(request.id);
  },
  specRead: (request) => specView(request.id),
  symbolIndex: (request) => {
    const index = SAMPLE_INDEX[request.repoId];
    if (index === undefined)
      throw new Error(
        "This repository is no longer connected. Choose it again in Settings.",
      );
    return "supported" in index
      ? { supported: false, reason: index.reason, languages: index.languages_seen }
      : {
          supported: true,
          names: index.files.flatMap((file) =>
            file.exports
              // `export * from` records the name `*`, which is not a name
              // a spec can refer to.
              .filter((each) => each.name !== "*")
              .map((each) => ({ name: each.name, kind: each.kind, path: file.path })),
          ),
          headCommit: index.head_commit,
          workingTree: index.working_tree,
          builtAt: index.built_at,
        };
  },
  impactRead: (request) => {
    const session = editing.read(request.id);
    const tracked = sampleFiles(session.repoId).filter((path) => !isNeverReadPath(path));
    const index = SAMPLE_INDEX[session.repoId];
    if (index === undefined) throw new Error("This sample repository is no longer connected.");
    const markdown = session.specSlug === null ? null : (specFiles()[session.specSlug] ?? null);
    return {
      ...impactReport({ scope: session.form.draft.paths, tracked, spec: markdown, index }),
      readAt: new Date().toISOString(),
    };
  },
  specSave: (request) => {
    const session = editing.read(request.id);
    if (session.repoId !== request.repoId)
      throw new Error("This planning belongs to another repository.");
    const slug = session.specSlug ?? specSlug(request.title);
    const existing = specFiles()[slug];
    if (session.specSlug === null && existing !== undefined)
      throw new Error(`specs/${slug}/spec.md already exists. Give this one a title of its own.`);
    const current = existing === undefined ? null : readSpecSections(existing);
    // The same merge the host does (SCP-321): a section this writer did not
    // change takes whatever the file says, and one both changed is refused
    // rather than overwritten.
    const merged = mergeSpecText({
      base: { title: request.base.title, ...request.base.sections },
      next: { title: request.title, ...request.sections },
      current: current?.text ?? EMPTY_SPEC_TEXT,
    });
    if (merged.conflicting.length > 0)
      return { view: specView(request.id), conflicting: merged.conflicting };
    const rendered = renderSpec(merged.text, {
      highWater: current?.highWater ?? 0,
      existing: current?.requirements ?? [],
    });
    saveSpec(slug, rendered.markdown);
    editing.recordSpec(request.id, slug);
    return { view: specView(request.id), conflicting: [] };
  },
  generatePlan: (request, owner) =>
    job(
      "draft",
      request.repoId,
      null,
      (job) => {
        const session = editing.read(request.id);
        if (session.specSlug === null) throw new Error("Write the spec before generating a plan from it.");
        const markdown = specFiles()[session.specSlug] ?? "";
        const ticket = newSampleTicket(readSpecSections(markdown).text.title || "Untitled work", "plan_review");
        draftFromSpec(ticket.key, markdown, session.specSlug);
        ticket.title = plans.get(ticket.key)!.outcome;
        snapshot.tasks.push({ repoId: request.repoId, repository: "webstore", ticket });
        job.resultKey = ticket.key;
      },
      1400,
      owner,
    ),
  startOver: (request, owner) =>
    job(
      "draft",
      request.repoId,
      request.key,
      (job) => {
        const session = editing.read(request.id);
        if (session.specSlug === null) throw new Error("Write the spec before generating a plan from it.");
        const markdown = specFiles()[session.specSlug] ?? "";
        const { ticket } = ticketRow(request.key);
        if (ticket.approved_at) throw new Error("An approved contract is immutable.");
        draftFromSpec(request.key, markdown, session.specSlug);
        ticket.plan_version += 1;
        job.resultKey = request.key;
      },
      1400,
      owner,
    ),
  login: () => {
    throw new Error("This is a sample workspace. The desktop app opens your terminal on the provider's sign-in command.");
  },
  openHelp: (request) => {
    window.open(HELP_LINKS[request.page], "_blank", "noopener");
    return null;
  },
  snapshot: () => ({
    ...structuredClone(snapshot),
    drafts: openDrafts(editingRecords()),
    interviews: [...sampleInterviews],
  }),
  repositorySnapshot: (request) => {
    const repository = snapshot.repositories.find((entry) => entry.id === request.repoId);
    if (!repository) throw new Error("This sample repository is no longer connected.");
    return structuredClone({ repository, tasks: snapshot.tasks.filter((entry) => entry.repoId === request.repoId), errors: [] });
  },
  detail: (request) => {
    if (!snapshot.tasks.some((row) => row.repoId === request.repoId && row.ticket.key === request.key)) throw new Error("Sample task not found in this repository.");
    return detail(request.key);
  },
  manifest: (request) =>
    structuredClone(
      sampleManifests.get(request.repoId) ?? {
        digest: "1".repeat(64),
        testCommand: "pnpm test",
        value: {
          offLimits: [".github/**", "infra/**", "**/*.env*"],
          entries: [
            ".env.local",
            ".certs/dev.pem",
            "fixtures/seed.json",
          ].map((path) => ({
            path,
            source_path: path,
            kind: "file" as const,
            strategy: "copy" as const,
            secret: true,
            required: true,
            reason: "Sample local setup",
          })),
        },
      },
    ),
  saveManifest: (request) => {
    sampleManifests.set(request.repoId, {
      digest: "2".repeat(64),
      value: request.value,
      testCommand: "pnpm test",
    });
    snapshot.repositories = snapshot.repositories.map((repo) =>
      repo.id === request.repoId
        ? {
            ...repo,
            manifestCount: request.value.entries.length,
            prohibitedPaths: request.value.offLimits,
          }
        : repo,
    );
    emit();
    return null;
  },
  models: (request) => ({
    provider: request.provider,
    source: "sample",
    discoveredAt: new Date().toISOString(),
    models: (request.provider === "codex-cli"
      ? ([
          ["o-class", "O-class", "Sample reviewer"],
          ["codex-sample", "Codex sample", "Sample coding model"],
        ] as const)
      : ([
          ["sonnet-class", "Sonnet-class", "Sample executor"],
          ["opus-sample", "Opus sample", "Sample reasoning model"],
        ] as const)
    ).map(([id, label, description], index): ProviderModel => ({
      id,
      label,
      description,
      isDefault: index === 0,
    })),
  }),
  providers: () => [
    {
      id: "claude",
      name: "Claude Code",
      installed: true,
      authenticated: true,
      detail: "Sample connection · subscription CLI",
      loginCommand: "claude auth login",
      roles: ["Execution", "Independent review", "Planning"],
    },
    {
      id: "codex",
      name: "Codex",
      installed: true,
      authenticated: true,
      detail: "Sample connection · subscription CLI",
      loginCommand: "codex login",
      roles: ["Execution", "Independent review", "Planning"],
    },
  ],
  saveSettings: (request) => {
    snapshot.settings = request.settings;
    emit({ kind: "preferences", settings: snapshot.settings, titles: snapshot.titles ?? {}, taskModels: snapshot.taskModels ?? {}, archived: snapshot.archived ?? [] });
    return request.settings;
  },
  archive: (request) => {
    const entries = request.keys.map((key) => request.repoId + ":" + ticketRow(key).ticket.key);
    snapshot.archived = request.archived
      ? [...new Set([...(snapshot.archived ?? []), ...entries])]
      : (snapshot.archived ?? []).filter((entry) => !entries.includes(entry));
    emit({ kind: "preferences", settings: snapshot.settings, titles: snapshot.titles ?? {}, taskModels: snapshot.taskModels ?? {}, archived: snapshot.archived });
    return null;
  },
  discard: (request) => {
    const row = ticketRow(request.key);
    if (!["draft", "specifying", "plan_review", "ready", "plan_invalid"].includes(row.ticket.state))
      throw new Error("Only a contract that has never run can be deleted. This one has moved past the contract stage.");
    snapshot.tasks = snapshot.tasks.filter((entry) => entry !== row);
    plans.delete(request.key);
    emit({ kind: "records", repoId: request.repoId, key: null });
    return null;
  },
  taskSummary: (request) => {
    if (!snapshot.tasks.some((row) => row.repoId === request.repoId && row.ticket.key === request.key)) throw new Error("Sample task not found in this repository.");
    return sampleSummary(request.key);
  },
  // The boards' figures; the desktop reads its own records.
  usage: () => ({
    readAt: new Date().toISOString(),
    ledger: { month: new Date().toISOString().slice(0, 7), spentMicros: 24_500_000, pricedAttempts: 41, unpricedAttempts: 0, ticketsRun: 34, ticketsMerged: 18, stoppedShort: 2, averageMergedMicros: 1_380_000 },
    providers: [
      { id: "claude", name: "Claude Code", role: "default executor", plan: "Max · 20×", detail: "Sample plan · read from the provider's reply", windows: [
        { label: "Session · 5-hour window", usedPercent: 78, resetsAt: new Date(Date.now() + 108 * 60_000).toISOString() },
        { label: "Weekly · all models", usedPercent: 41, resetsAt: new Date(Date.now() + 3 * 86_400_000).toISOString() },
        { label: "Weekly · opus-class", usedPercent: 12, resetsAt: new Date(Date.now() + 3 * 86_400_000).toISOString() },
      ] },
      { id: "codex", name: "Codex", role: "default reviewer", plan: "Pro", detail: "Sample plan · read from the provider's reply", windows: [
        { label: "Session · 5-hour window", usedPercent: 23, resetsAt: new Date(Date.now() + 133 * 60_000).toISOString() },
        { label: "Weekly · all models", usedPercent: 18, resetsAt: new Date(Date.now() + 3 * 86_400_000).toISOString() },
      ] },
      { id: "anthropic", name: "Anthropic API", role: null, plan: null, windows: null, detail: "No API key on this machine, so there is no plan to report." },
    ],
    notes: ["Sample figures. The desktop reads its own records."],
  }),
  rename: (request) => {
    snapshot.titles = {
      ...snapshot.titles,
      [request.repoId + ":" + request.key]: request.title,
    };
    emit({ kind: "preferences", settings: snapshot.settings, titles: snapshot.titles ?? {}, taskModels: snapshot.taskModels ?? {}, archived: snapshot.archived ?? [] });
    return null;
  },
  chooseRepository: () => {
    if (!snapshot.repositories.length) snapshot.repositories = [...initial.repositories];
    const chosen = snapshot.repositories[0] ?? null;
    emit({ kind: "repositories" });
    return chosen;
  },
  forgetRepository: (request) => {
    snapshot.repositories = snapshot.repositories.filter(
      (repo) => repo.id !== request.repoId,
    );
    snapshot.tasks = snapshot.tasks.filter(
      (row) => row.repoId !== request.repoId,
    );
    emit();
    return null;
  },
  doctor: (request) =>
    job("doctor", request.repoId, null, (job) => {
      const repo = snapshot.repositories.find(
        (repo) => repo.id === request.repoId,
      )!;
      if (request.writeConfig) repo.configured = true;
      job.log =
        "Sample readiness check\n✓ Git checkout available\n✓ pnpm test detected\n✓ Worktree preparation available\n3 manifest files selected";
    }),
  draft: (request, owner) =>
    job(
      "draft",
      request.repoId,
      null,
      (job) => {
        const ticket = newSampleTicket("Activation email never sent on signup", "plan_review");
        applyDraft(ticket, {
          outcome: request.outcome,
          criteria: criteriaText.map((text) => ({
            text,
            assertion: text,
            kind: "test",
          })),
          paths: ["packages/auth/**", "packages/queue/**"],
          prohibited: [],
        });
        snapshot.tasks.push({
          repoId: request.repoId,
          repository: "webstore",
          ticket,
        });
        if (request.models) {
          snapshot.taskModels = {
            ...snapshot.taskModels,
            [request.repoId + ":" + ticket.key]: request.models,
          };
          emit({ kind: "preferences", settings: snapshot.settings, titles: snapshot.titles ?? {}, taskModels: snapshot.taskModels, archived: snapshot.archived ?? [] });
        }
        job.resultKey = ticket.key;
      },
      2200,
      owner,
    ),
  admit: (request, owner) =>
    job(
      "admit",
      request.repoId,
      null,
      (job) => {
        const ticket = newSampleTicket(request.draft.outcome, "plan_review");
        applyDraft(ticket, request.draft);
        snapshot.tasks.push({
          repoId: request.repoId,
          repository: "webstore",
          ticket,
        });
        if (request.models) {
          snapshot.taskModels = {
            ...snapshot.taskModels,
            [request.repoId + ":" + ticket.key]: request.models,
          };
          emit({ kind: "preferences", settings: snapshot.settings, titles: snapshot.titles ?? {}, taskModels: snapshot.taskModels, archived: snapshot.archived ?? [] });
        }
        job.resultKey = ticket.key;
      },
      1100,
      owner,
    ),
  edit: (request, owner) =>
    job("edit", request.repoId, request.key, (job) => {
      const { ticket } = ticketRow(request.key);
      if (!snapshot.tasks.some((row) => row.repoId === request.repoId && row.ticket.key === request.key)) throw new Error("Sample task not found in this repository.");
      if (ticket.approved_at) throw new Error("An approved contract cannot be edited.");
      if (detail(request.key).digest !== request.digest) throw new Error("The contract changed since you viewed it.");
      applyDraft(ticket, request.draft);
      ticket.plan_version += 1;
      if (request.models) {
        snapshot.taskModels = {
          ...snapshot.taskModels,
          [request.repoId + ":" + ticket.key]: request.models,
        };
        emit({ kind: "preferences", settings: snapshot.settings, titles: snapshot.titles ?? {}, taskModels: snapshot.taskModels, archived: snapshot.archived ?? [] });
      }
      job.resultKey = request.key;
    }, 1000, owner),
  run: (request) => startWork(request.kind, request.repoId, request.key),
  decide: (request) => startWork(request.kind, request.repoId, request.key),
  principle: (request) =>
    job(request.kind, request.repoId, request.key, () => {
      decisionsAnswered.add(request.key);
    }),
  verdict: (request) =>
    job(request.kind, request.repoId, request.key, () => {
      decisionsAnswered.add(request.key);
    }),
  cancel: async (request) => {
    const active = snapshot.jobs.find((job) => job.id === request.jobId);
    // As the host has it: a job that has finished is not one a stop can reach.
    if (!active || !isLive(active)) throw new Error("That command is no longer active.");
    active.state = "cancelled";
    active.endedAt = new Date().toISOString();
    if (active.key && ["run", "decide"].includes(active.kind)) ticketRow(active.key).ticket.state = "cancelled";
    await editing.settled(active);
    emit({ kind: "records", repoId: active.repoId, key: active.resultKey ?? active.key, job: active });
    return null;
  },
  sync: (request) =>
    job("sync", request.repoId, request.key, () => {
      const { ticket } = ticketRow(request.key);
      if (ticket.delivery.state === "open") {
        ticket.state = "merged";
        ticket.delivery.state = "merged";
        ticket.delivery.observed_at = new Date().toISOString();
      }
    }),
  // The screens show the GitHub handoff; no external site opens in this sandbox.
  openPullRequest: () => null,
  openWorktree: () => {
    throw new Error("This is a sample repository. The desktop app opens your real folder.");
  },
  openRepository: () => {
    throw new Error("This is a sample repository. The desktop app opens your real folder.");
  },
  output: (request) => {
    const { attempts } = detail(request.key);
    if (!snapshot.tasks.some((row) => row.repoId === request.repoId && row.ticket.key === request.key)) throw new Error("Sample task not found in this repository.");
    if (request.attemptId && !attempts.some((entry) => entry.id === request.attemptId)) throw new Error("The selected attempt does not belong to this task.");
    return { transcript: attempts.length > 0 ? sampleTranscript() : null, diff: null, notes: [] };
  },
  exportArchive: async (request) => {
    const csv = archiveCsv(archiveRows(snapshot, request), snapshot.titles);
    await navigator.clipboard.writeText(csv);
    return csv;
  },
  export: async (request) => {
    const data = request.key
      ? detail(request.key)
      : snapshot.tasks.filter((row) => row.repoId === request.repoId);
    const text = JSON.stringify(data, null, 2);
    await navigator.clipboard.writeText(text);
    return text;
  },
};

/**
 * A run or a decision, which move the ticket the moment the command is
 * accepted: a refused one leaves it where it was, so the job is opened first
 * and the ticket is moved only after that returned.
 */
function startWork(kind: "run" | "decide", repoId: string, key: string) {
  const row = ticketRow(key);
  const opened = job(
    kind,
    repoId,
    key,
    () => {
      if (!decisionsAnswered.has(key)) row.ticket.state = "changes_requested";
      else {
        row.ticket.state = "pr_open";
        row.ticket.delivery.state = "open";
        row.ticket.delivery.pull_request_number = 418;
        row.ticket.delivery.pull_request_url = "https://github.com/example/webstore/pull/418";
        approved.add(key);
      }
    },
    2600,
  );
  row.ticket.approved_at = at;
  row.ticket.state = "executing";
  if (kind === "decide") decisionsAnswered.add(key);
  return opened;
}

/**
 * Answer one request from the table. The bridge calls this for a renderer, and
 * an editing session calls it for the job it starts, which is why the table is
 * reachable from the records rather than only from the bridge.
 */
export async function answer<T extends Request>(
  request: T,
  owner?: EditingOwner,
): Promise<ReplyMap[T["kind"]]> {
  const handler = handlers[request.kind] as (
    r: T,
    context: EditingOwner | undefined,
  ) => Promise<ReplyMap[T["kind"]]> | ReplyMap[T["kind"]];
  return await handler(request, owner);
}
