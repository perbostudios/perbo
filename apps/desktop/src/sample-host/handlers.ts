import {
  applyGraphEdit,
  EMPTY_SPEC_TEXT,
  impactReport,
  mergeSpecText,
  readSpecSections,
  renderSpec,
  specSlug,
} from "@perbo/planning/browser";
import { isNeverReadPath } from "@perbo/contracts/browser";
import type { DriftVerdict } from "@perbo/planning/browser";
import type { GraphEdit } from "@perbo/contracts/browser";
import { openDrafts, turnMark } from "../shared/contract-editing.js";
import type { EditingOwner } from "../shared/contract-editing.js";
import { archiveCsv, archiveRows, isArchivable, notArchivable } from "../shared/archive.js";
import { heldRepository, isLive, isRun } from "../shared/jobs.js";
import { ANOTHER_PLANNING_HOLDS, DELETE_TICKET_GONE, DELETE_WAITS_FOR_COMMANDS } from "../shared/discard.js";
import { HELP_LINKS, TaskModelsSchema } from "../shared/protocol.js";
import type { Job, ReplyMap, Request, RequestHandlers } from "../shared/protocol.js";
import {
  afterTheNote,
  applyDraft,
  approved,
  at,
  decisionsAnswered,
  detail,
  draftFromSpec,
  driftEpoch,
  driftKeys,
  driftLanded,
  driftRecords,
  driftTarget,
  discardTicket,
  editing,
  editingRecords,
  emit,
  endPlanningChat,
  emitPreferences,
  forgetDrift,
  graphLog,
  graphView,
  initial,
  interviewStatus,
  isWorking,
  job,
  marks,
  nameSampleSpec,
  nameSpecFromTurn,
  newSampleTicket,
  pairAtTurn,
  plans,
  readings,
  readingSettled,
  recordDrift,
  removeSpecFile,
  SAMPLE_INDEX,
  sampleCatalog,
  sampleDriftFindings,
  sampleFiles,
  sampleManifests,
  sampleRead,
  sampleSummary,
  sampleInterviews,
  sampleWorking,
  sampleTranscript,
  saveSpec,
  snapshot,
  specFiles,
  specOf,
  specSectionsAt,
  specView,
  standingFor,
  startSampleInterview,
  stopSampleInterview,
  ticketRow,
  undoGraphEditAt,
  writeGraphEdit,
  answerSampleTurn,
  askingChanged,
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
  editingOpen: (request) => {
    // As the host does: a spec is opened by the folder that is there, and one
    // that has gone says so rather than being minted back by the save.
    if (request.target.kind === "spec" && specFiles()[request.target.slug] === undefined)
      throw new Error(
        "That spec is no longer in the repository. It may have been renamed or removed " +
          "since this list was read.",
      );
    return editing.open(request.target, request.legacy);
  },
  editingRead: (request) => editing.read(request.id),
  drafts: () => openDrafts(editingRecords()),
  editingSave: (request) => editing.save(request.id, request.revision, request.repoId, request.form),
  editingSubmit: (request) =>
    editing.submit(request.id, request.revision, request.operationId, request.intent),
  editingStop: (request) => editing.stop(request.id),
  editingVisited: (request) => editing.visit(request.id, request.pane),
  editingContractVisited: (request) => editing.visitContract(request.id),
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
        // What the plan promised before, so what the edit changed of it can be
        // marked on every planning over the ticket, as the host does; an edit
        // that only rearranged the graph marks nothing.
        const before = marks.promiseAt({ id: request.repoId }, request.key);
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
        marks.recordPlanChange({ id: request.repoId }, request.key, before);
      },
      120,
    ),
  graphUndo: (request) =>
    job(
      request.kind,
      request.repoId,
      request.key,
      (job) => {
        const before = marks.promiseAt({ id: request.repoId }, request.key);
        undoGraphEditAt(request.key, request.edit);
        job.resultKey = request.key;
        marks.recordPlanChange({ id: request.repoId }, request.key, before);
      },
      120,
    ),
  explorerMark: (request) => {
    // As on the real host: an approved contract's scope is frozen, and a mark
    // against one could never be compiled in. The standing list is the
    // repository's rather than this ticket's, so it stays writable — either
    // way on it, which is what `always` being set at all means: true adds the
    // path and false takes back what this draft added. Null is the ticket's
    // own scope, and that is what the freeze holds.
    const marking = editing.read(request.id);
    const held =
      marking.key === null
        ? undefined
        : snapshot.tasks.find((entry) => entry.ticket.key === marking.key);
    if (held?.ticket.approved_at && request.always === null)
      throw new Error(
        "This contract is approved, so its scope is frozen. Start over from the spec to plan it again.",
      );
    return editing.mark(request.id, request.revision, request.path, request.mark, request.always);
  },
  explorerUndo: (request) => editing.undo(request.id, request.revision, request.edit),
  editingDiscard: (request) => {
    // The ticket this planning drafted goes with it, as it does on the real
    // host: a plan thrown away must not leave its ticket on the board with no
    // way back to the plan, whatever stage it had reached (D-129). One this
    // planning was merely opened over was never its to throw away.
    const held = editing.read(request.id);
    // A command running in the repository holds the delete of the ticket this
    // planning drafted, so the discard is refused before anything goes, as the
    // host refuses it.
    if (held.key !== null && held.admitted && heldRepository(snapshot.jobs, held.repoId))
      throw new Error(DELETE_WAITS_FOR_COMMANDS);
    const session = editing.discard(request.id, request.revision);
    endPlanningChat(request.id);
    let refused: string | null = null;
    if (held.key !== null && held.admitted) refused = discardTicket(held.repoId, held.key);
    // A planning that never took the ticket drafted from its own spec still
    // deletes it: the row being thrown away stood for that work. Not where
    // another planning curates it, by the spec it writes or the ticket it
    // holds: that one is the planning to throw it away.
    if (held.key === null && held.specSlug !== null) {
      const mine = snapshot.tasks.filter(
        (entry) =>
          entry.repoId === held.repoId &&
          entry.ticket.state === "plan_review" &&
          entry.ticket.admission.spec?.path === `specs/${held.specSlug!}/spec.md`,
      );
      const curated = (key: string): boolean =>
        editingRecords().some(
          (each) =>
            each.id !== request.id &&
            each.repoId === held.repoId &&
            (each.specSlug === held.specSlug || each.key === key) &&
            each.phase !== "discarded",
        );
      if (mine.length === 1)
        refused = curated(mine[0]!.ticket.key)
          ? ANOTHER_PLANNING_HOLDS
          : discardTicket(held.repoId, mine[0]!.ticket.key);
    }
    // Work left standing is said, as the host says it: the planning has gone,
    // and the ticket stays where it is listed, to delete once what holds it has
    // settled. A ticket already gone left nothing to delete, and one another
    // planning holds is that planning's.
    if (refused !== null && refused !== DELETE_TICKET_GONE && refused !== ANOTHER_PLANNING_HOLDS)
      throw new Error(refused);
    // And the spec they came from, once nothing is left holding it, a ticket
    // already gone included: it names the folder no more than a deleted one
    // does (D-129). Not where the ticket refused to go: a plan still standing
    // is read against the spec it names (D-103).
    if (held.specSlug !== null && (refused === null || refused === DELETE_TICKET_GONE)) {
      removeSpecFile(held.specSlug, { sessionId: request.id });
      emit({ kind: "records", repoId: held.repoId, key: null });
    }
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
    // The turn is with the session: it is working until it has answered, as
    // the host reports of a real one. And the pair as it stands, where this is
    // the first turn owed, so what the turns changed can be marked once the
    // last of them is over.
    const owed = (sampleWorking.get(request.id) ?? 0) + 1;
    if (owed === 1) pairAtTurn.set(request.id, marks.pairOf(request.id));
    sampleWorking.set(request.id, owed);
    afterTheNote.delete(request.id);
    converse(request.id, { kind: "turn", text: request.text });
    editing.answerAsking(request.id, request.text);
    askingChanged(request.id);
    const text = request.text;
    setTimeout(() => answerSampleTurn(request.id, text), 120);
    return interviewStatus(request.id);
  },
  interviewStop: (request) => {
    stopSampleInterview(request.id);
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
  // The same reading, of a compiled contract's own scope. Answered from the
  // ticket rather than from a planning session, as the host answers it: the
  // contract page is reached from a ticket, and one the CLI admitted never had
  // a session.
  impactContract: (request) => {
    const tracked = sampleFiles(request.repoId).filter((path) => !isNeverReadPath(path));
    const index = SAMPLE_INDEX[request.repoId];
    if (index === undefined) throw new Error("This sample repository is no longer connected.");
    const contract = plans.get(request.key);
    if (contract === undefined) throw new Error("That contract is no longer here.");
    // The spec the ticket was drafted from, as the host reads it off the
    // ticket's admission record; here, off the planning that drafted it.
    const slug = editingRecords().find((record) => record.key === request.key)?.specSlug ?? null;
    return {
      ...impactReport({
        scope: contract.scope.paths_allowed,
        tracked,
        spec: slug === null ? null : (specFiles()[slug] ?? null),
        index,
      }),
      readAt: new Date().toISOString(),
    };
  },
  // The plan read against its spec, as the host runs `perbo drift`: the
  // verdict held while the spec and the plan's promises stand where they were
  // read, and read again where either moved.
  driftCheck: (request) => {
    const key = driftTarget(request.id);
    const id = request.id;
    // The state the reading is of, as the host captures it: a dismissal or an
    // approval while it runs moves this on.
    const epoch = driftEpoch.get(key) ?? 0;
    // Whether the interview's turn is in flight as the reading starts, and the
    // last one sent, as the host takes them.
    const before = turnMark(editing.read(id), isWorking(id));
    // The spec and the plan as the reading starts, which is when `perbo drift`
    // reads them: a turn that moves either while it runs is not in what it
    // finds.
    const slug = specOf.get(key);
    const unreadable = slug !== undefined && specFiles()[slug] === undefined;
    const keys = driftKeys(key);
    const findings = unreadable ? [] : sampleDriftFindings(key);
    const reading = job(
      "drift",
      editing.read(id).repoId,
      key,
      (job) => {
        // A spec that cannot be read is the reading failing, as `perbo drift`
        // fails on one: the job carries the error, and the page reads it off
        // the job.
        if (unreadable) throw new Error(`specs/${slug}/spec.md could not be read.`);
        const held = driftRecords.get(key);
        const verdict: DriftVerdict =
          held !== undefined &&
          keys !== null &&
          held.spec === keys.spec &&
          held.promises === keys.promises
            ? { ...held, cached: true }
            : recordDrift(key, "read", findings, false, keys);
        job.result = verdict;
        driftLanded(id, key, epoch, before, verdict);
      },
      600,
      undefined,
      () => readingSettled(id),
    );
    // In flight from here until the job has settled, however it ends.
    readings.add(id);
    return reading;
  },
  driftDismiss: (request) => {
    const key = driftTarget(request.id);
    const held = driftRecords.get(key);
    const keys = driftKeys(key);
    if (held === undefined || keys === null || held.spec !== keys.spec || held.promises !== keys.promises)
      throw new Error("Nothing has been read at this state. Read the plan against the spec first.");
    driftRecords.set(key, { ...held, dismissed: true });
    // And the problems the session held go with it, as the host drops them.
    forgetDrift(key, request.id);
    return null;
  },
  specDelete: (request) => {
    // As the host does: a spec a ticket was drafted from stays, because a plan
    // is read against the spec it names (D-103).
    const held = snapshot.tasks.find(
      (each) => each.ticket.admission.spec?.path === `specs/${request.slug}/spec.md`,
    );
    if (held)
      throw new Error(
        `${held.ticket.key} was drafted from this spec, and a plan is read against the spec ` +
          "it names. Delete that contract first, and the spec is yours to delete.",
      );
    if (editingRecords().some((each) => each.specSlug === request.slug && each.phase !== "discarded"))
      throw new Error(
        "A planning is writing this spec. Throw that planning away first, and the spec is " +
          "yours to delete.",
      );
    removeSpecFile(request.slug, { sessionId: null });
    return null;
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
    // What the file said before, for the marks on what this save changed of
    // it: nothing at all where there is no file yet.
    const before = session.specSlug === null ? null : specSectionsAt(session.specSlug);
    const rendered = renderSpec(merged.text, {
      highWater: current?.highWater ?? 0,
      existing: current?.requirements ?? [],
    });
    saveSpec(slug, rendered.markdown);
    editing.recordSpec(request.id, slug);
    // The change this save made, on every planning writing this spec: a save
    // of the same words changes nothing and marks nothing.
    marks.markChangeOn({ spec: before, plan: null }, { spec: specSectionsAt(slug), plan: null }, (each) => each.specSlug === slug);
    return { view: specView(request.id), conflicting: [] };
  },
  replan: async (request) => {
    const { ticket } = ticketRow(request.key);
    // The spec the stopped plan was drafted from, in the words the CLI refuses
    // in, because this is the same question `admit --start-over` asks and a
    // person should not meet two sentences for one answer.
    //
    // Built from the spec folder and the slug the record names, never from
    // the recorded string itself, as the host builds it: a recorded path that
    // leaves the spec folder is a spec this admission has no business reading.
    const parts = ticket.admission.spec?.path?.split("/") ?? [];
    const named =
      parts.length === 3 && parts[0] === "specs" && parts[2] === "spec.md" ? parts[1]! : null;
    if (named === null)
      throw new Error(
        `${request.key} was not drafted from a spec, so there is no spec to start over from. A plan ` +
          "drafted from a spec is admitted with perbo admit --from-spec",
      );
    const spec = `specs/${named}/spec.md`;
    // And the file has to be there, asked before anything is drafted and in
    // the sentence the command itself refuses in: a spec deleted since is the
    // reachable way to press this with nothing to draft from.
    if (specFiles()[named] === undefined) throw new Error(`no spec at ${spec}`);
    // And only beside a spent record, in `admit`'s own words: a spec whose
    // ticket is still live has its plan.
    if (!["failed", "plan_invalid", "cancelled"].includes(ticket.state))
      throw new Error(
        `${request.key} was already drafted from ${spec}, and one spec is one piece of work: ` +
          `${request.key} is ${ticket.state}, which is past re-drafting, so this spec has its plan`,
      );
    // On this ticket's own models, and the new plan keeps them: it is the same
    // work, and a person who chose what drafts it did not choose again by
    // pressing this.
    const models = snapshot.taskModels?.[request.repoId + ":" + request.key];
    // The stopped ticket goes, and its attempts and evidence with it, which
    // this sample holds beside the ticket; the spec stays, because the new
    // plan is drafted from it. Deleted first, as the host deletes it, so the
    // new plan is named as the only plan this spec has.
    const refusal = discardTicket(request.repoId, request.key);
    if (refusal !== null) throw new Error(refusal);
    // A fresh admission, not a move: the approved contract is frozen
    // (ADR-0016), so the plan is drafted again from the spec.
    const markdown = specFiles()[named] ?? "";
    const drafted = newSampleTicket("", "plan_review");
    snapshot.tasks.push({ repoId: request.repoId, repository: "webstore", ticket: drafted });
    draftFromSpec(drafted.key, markdown, named);
    if (models)
      snapshot.taskModels = { ...snapshot.taskModels, [request.repoId + ":" + drafted.key]: models };
    const opened = await editing.open({ kind: "planning", repoId: request.repoId, key: drafted.key }, undefined);
    emit({ kind: "records", repoId: request.repoId, key: drafted.key });
    return { sessionId: opened.id, pane: opened.nodes > 0 ? "graph" : "criteria" };
  },
  generatePlan: (request, owner) =>
    job(
      "draft",
      request.repoId,
      null,
      (job) => {
        const session = editing.read(request.id);
        if (session.specSlug === null) throw new Error("Write the spec before generating a plan from it.");
        // A group of questions the person has not answered is a spec still
        // moving, as the host reads it: drafting over it turns a spec the
        // answers were about to change into a plan (D-117).
        if (session.asking !== null)
          throw new Error(
            "Answer the chat's questions first — its answers change the spec this drafts from.",
          );
        // One press does both, as the host does it: the interview is still
        // talking for as long as it is writing, and this press ends the
        // conversation and drafts from what it left behind rather than asking
        // for a stop by hand and then a second press. Behind the refusal
        // above, so a standing question still stops it.
        stopSampleInterview(request.id);
        const markdown = specFiles()[session.specSlug] ?? "";
        refuseUnnumbered(markdown);
        const ticket = newSampleTicket("", "plan_review");
        // Admitted now, as `admit --from-spec` stamps it: the chat reads the
        // interview that came before the plan off this moment.
        ticket.admitted_at = new Date().toISOString();
        // On the board before it is drafted, so the drafting finds the row to
        // record the spec on: a ticket is what says a spec has a plan.
        snapshot.tasks.push({ repoId: request.repoId, repository: "webstore", ticket });
        draftFromSpec(ticket.key, markdown, session.specSlug);
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
        refuseUnnumbered(markdown);
        const { ticket } = ticketRow(request.key);
        if (ticket.approved_at) throw new Error("An approved contract is immutable.");
        // What the plan promised before it is drafted again, for the marks on
        // the re-draft.
        const before = marks.promiseAt({ id: request.repoId }, request.key);
        draftFromSpec(request.key, markdown, session.specSlug);
        // A name the person gave the ticket outlives the re-draft, as the host
        // keeps it on the spec.
        const given = snapshot.titles?.[request.repoId + ":" + request.key];
        if (given !== undefined) nameSampleSpec(request.repoId, request.key, given);
        ticket.plan_version += 1;
        job.resultKey = request.key;
        marks.recordPlanChange({ id: request.repoId }, request.key, before);
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
    // The specs this sample workspace holds, as the host reads its own folder:
    // the picker subtracts the ones a planning or a ticket names and offers
    // what is left (D-129).
    specs: Object.entries(specFiles()).flatMap(([slug, markdown]) => {
      const repoId = snapshot.repositories[0]?.id;
      if (repoId === undefined) return [];
      const title = readSpecSections(markdown).text.title.trim();
      return title.length > 0 ? [{ repoId, slug, title }] : [];
    }),
    interviews: [...sampleInterviews],
    working: [...sampleWorking.keys()],
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
  models: (request) => sampleCatalog(request.provider),
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
    emitPreferences();
    return request.settings;
  },
  taskModels: (request) => {
    // As the host does: this one ticket's own models, refused once the
    // contract is approved, because what runs is settled with it.
    const row = snapshot.tasks.find(
      (each) => each.repoId === request.repoId && each.ticket.key === request.key,
    );
    if (row === undefined) throw new Error(`${request.key} is not in this repository.`);
    if (row.ticket.approved_at !== null)
      throw new Error(
        `${request.key} is approved, and what it runs on was settled with it. Its models are ` +
          "no longer this page's to change.",
      );
    snapshot.taskModels = {
      ...(snapshot.taskModels ?? {}),
      [request.repoId + ":" + request.key]: TaskModelsSchema.strip().parse(request.models),
    };
    emitPreferences();
    return null;
  },
  archive: (request) => {
    const carried = request.archived
      ? request.keys.map((key) => ticketRow(key)).find((row) => !isArchivable(snapshot, row))
      : undefined;
    if (carried !== undefined) throw new Error(notArchivable(carried.ticket.key));
    const entries = request.keys.map((key) => request.repoId + ":" + ticketRow(key).ticket.key);
    snapshot.archived = request.archived
      ? [...new Set([...(snapshot.archived ?? []), ...entries])]
      : (snapshot.archived ?? []).filter((entry) => !entries.includes(entry));
    emitPreferences();
    return null;
  },
  discard: (request) => {
    // Which spec it was drafted from, read before the row goes.
    const drafted =
      snapshot.tasks
        .find((row) => row.repoId === request.repoId && row.ticket.key === request.key)
        ?.ticket.admission.spec?.path?.split("/")
        .at(-2) ?? null;
    // Deleting work outright says the reason it stays, in the host's words.
    const refusal = discardTicket(request.repoId, request.key);
    if (refusal !== null) throw new Error(refusal);
    // The spec goes with the plan it drafted: a piece of work is deleted whole.
    if (drafted !== null) {
      removeSpecFile(drafted, { sessionId: null });
      emit({ kind: "records", repoId: request.repoId, key: null });
    }
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
      { id: "claude", name: "Claude Code", role: "default executor", connected: true, plan: "Max", detail: "Read from Claude Code.", windows: [
        { label: "5-hour limit", usedPercent: 78, resetsAt: new Date(Date.now() + 108 * 60_000).toISOString() },
        { label: "Weekly · all models", usedPercent: 41, resetsAt: new Date(Date.now() + 3 * 86_400_000).toISOString() },
        { label: "Weekly · Fable", usedPercent: 12, resetsAt: new Date(Date.now() + 3 * 86_400_000).toISOString() },
      ] },
      { id: "codex", name: "Codex", role: "default reviewer", connected: true, plan: "Pro", detail: "Read from the Codex app-server.", windows: [
        { label: "5-hour limit", usedPercent: 23, resetsAt: new Date(Date.now() + 133 * 60_000).toISOString() },
        { label: "Weekly · all models", usedPercent: 18, resetsAt: new Date(Date.now() + 3 * 86_400_000).toISOString() },
      ] },
      { id: "anthropic", name: "Anthropic API", role: null, connected: false, plan: null, windows: null, detail: "No API key in the app environment." },
    ],
    notes: ["Sample figures. The desktop reads its own records."],
  }),
  askSave: (request) => {
    // As the host keeps it: by repository, an empty text removing it.
    if (!snapshot.repositories.some((repo) => repo.id === request.repoId))
      throw new Error("This repository is no longer connected. Choose it again in Settings.");
    const asks = { ...snapshot.asks };
    if (request.text.length === 0) delete asks[request.repoId];
    else asks[request.repoId] = request.text;
    snapshot.asks = asks;
    return null;
  },
  rename: (request) => {
    snapshot.titles = {
      ...snapshot.titles,
      [request.repoId + ":" + request.key]: request.title,
    };
    emitPreferences();
    if (nameSampleSpec(request.repoId, request.key, request.title))
      emit({ kind: "records", repoId: request.repoId, key: request.key });
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
    delete snapshot.asks?.[request.repoId];
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
          emitPreferences();
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
      // What the plan promised before this edit, for the marks on it.
      const before = marks.promiseAt({ id: request.repoId }, request.key);
      applyDraft(ticket, request.draft);
      ticket.plan_version += 1;
      marks.recordPlanChange({ id: request.repoId }, request.key, before);
      if (request.models) {
        snapshot.taskModels = {
          ...snapshot.taskModels,
          [request.repoId + ":" + ticket.key]: request.models,
        };
        emitPreferences();
      }
      job.resultKey = request.key;
    }, 1000, owner),
  run: (request) => startWork(request.kind, request.repoId, request.key, request.publish),
  decide: (request) => startWork(request.kind, request.repoId, request.key, false),
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
    const settle = async (): Promise<void> => {
      active.state = "cancelled";
      active.endedAt = new Date().toISOString();
      if (active.key && isRun(active)) ticketRow(active.key).ticket.state = "cancelled";
      await editing.settled(active);
      emit({ kind: "records", repoId: active.repoId, key: active.resultKey ?? active.key, job: active });
    };
    // A loop is stopped as the host stops it: the stop is taken at once and
    // answered, and the run's record settles once its process has gone.
    if (isRun(active)) {
      if (active.state === "stopping") return null;
      active.state = "stopping";
      emit({ kind: "progress", job: active });
      setTimeout(() => void settle(), 400);
    } else await settle();
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
function startWork(kind: "run" | "decide", repoId: string, key: string, publish: boolean): Job {
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
  // On the job, as the host records it: what an attempt carried on from this
  // one after a stop publishes by.
  opened.publish = publish;
  row.ticket.approved_at = at;
  row.ticket.state = "executing";
  if (kind === "decide") decisionsAnswered.add(key);
  // A filed ticket whose loop starts again is back on Home, as the host has it.
  const entry = repoId + ":" + row.ticket.key;
  if (snapshot.archived?.includes(entry)) {
    snapshot.archived = snapshot.archived.filter((item) => item !== entry);
    emitPreferences();
  }
  // Approved, so what the plan promises is settled: every planning over it
  // forgets its problems, as the host does.
  forgetDrift(key, null);
  return opened;
}

/**
 * The drafter reads Requirements as list items, each beginning with its id:
 * an item without one, or text with no item at all, is refused in
 * `admit --from-spec`'s own words.
 */
function refuseUnnumbered(markdown: string): void {
  const stated = readSpecSections(markdown).text.requirements;
  const items = stated.split(/\r?\n/).flatMap((line) => {
    const item = /^[-*]\s+(.*)$/.exec(line.trim());
    return item ? [item[1]!.trim()] : [];
  });
  const unnumbered = items.find((item) => !/^R\d+:\s*\S/.test(item));
  if (unnumbered !== undefined)
    throw new Error(
      `the spec's requirement '${unnumbered}' does not begin with its id. Write each one as ` +
        "'- R1: what must be true', with ids R1 upward, never reused (D-103)",
    );
  if (stated.trim() !== "" && items.length === 0)
    throw new Error(
      "the spec's Requirements section names no requirement. Write each one as '- R1: what must " +
        "be true'; there is nothing to draft a contract from without them",
    );
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
