import { z } from "zod";

/** The versioned catalogue shipped with Perbo (D-094). */
export const EXECUTOR_SKILLS = [
  {
    id: "ask-matt",
    label: "Ask matt",
    description:
      "Ask which skill or flow fits your situation. A router over the skills in this repo.",
    userInvoked: true,
  },
  {
    id: "diagnosing-bugs",
    label: "Diagnosing bugs",
    description:
      'Diagnosis loop for hard bugs and performance regressions. Use when the user says "diagnose"/"debug this", or reports something broken/throwing/failing/slow.',
    userInvoked: false,
  },
  {
    id: "grill-with-docs",
    label: "Grill with docs",
    description:
      "A relentless interview to sharpen a plan or design, which also creates docs (ADR's and glossary) as we go.",
    userInvoked: true,
  },
  {
    id: "triage",
    label: "Triage",
    description:
      "Move issues and external PRs through a state machine of triage roles, categorise, verify, grill if needed, and write agent-ready briefs.",
    userInvoked: true,
  },
  {
    id: "improve-codebase-architecture",
    label: "Improve codebase architecture",
    description:
      "Scan a codebase for deepening opportunities, present them as a visual HTML report, then grill through whichever one you pick.",
    userInvoked: true,
  },
  {
    id: "setup-matt-pocock-skills",
    label: "Setup matt pocock skills",
    description:
      "Configure this repo for the engineering skills: set up its issue tracker, triage label vocabulary, and domain doc layout. Run once before first use of the other engineering skills.",
    userInvoked: true,
  },
  {
    id: "tdd",
    label: "Tdd",
    description:
      'Test-driven development. Use when the user wants to build features or fix bugs test-first, mentions "red-green-refactor", or wants integration tests.',
    userInvoked: false,
  },
  {
    id: "to-spec",
    label: "To spec",
    description:
      "Turn the current conversation into a spec and publish it to the project issue tracker: no interview, just synthesis of what you've already discussed.",
    userInvoked: true,
  },
  {
    id: "to-tickets",
    label: "To tickets",
    description:
      "Break a plan, spec, or the current conversation into a set of tracer-bullet tickets, each declaring its blocking edges, published to the configured tracker (edges as text in one file per ticket locally, or native blocking links on a real tracker).",
    userInvoked: true,
  },
  {
    id: "wayfinder",
    label: "Wayfinder",
    description:
      "Plan a huge chunk of work (more than one agent session can hold) as a shared map of decision tickets on your issue tracker, and resolve them one at a time until the way to the destination is clear.",
    userInvoked: true,
  },
  {
    id: "implement",
    label: "Implement",
    description: "Implement a piece of work based on a spec or set of tickets.",
    userInvoked: true,
  },
  {
    id: "prototype",
    label: "Prototype",
    description:
      "Build a throwaway prototype to answer a design question. Use when the user wants to sanity-check whether a state model or logic feels right, or explore what a UI should look like.",
    userInvoked: false,
  },
  {
    id: "research",
    label: "Research",
    description:
      "Investigate a question against high-trust primary sources and capture the findings as a Markdown file in the repo. Use when the user wants a topic researched, docs or API facts gathered, or reading legwork delegated to a background agent.",
    userInvoked: false,
  },
  {
    id: "domain-modeling",
    label: "Domain modeling",
    description:
      "Build and sharpen a project's domain model. Use when discussing codebase terminology, writing or editing a CONTEXT.md, or recording or editing an ADR.",
    userInvoked: false,
  },
  {
    id: "codebase-design",
    label: "Codebase design",
    description:
      "Shared vocabulary for designing deep modules. Use when the user wants to design or improve a module's interface, find deepening opportunities, decide where a seam goes, make code more testable or AI-navigable, or when another skill needs the deep-module vocabulary.",
    userInvoked: false,
  },
  {
    id: "code-review",
    label: "Code review",
    description:
      'Review the changes since a fixed point (commit, branch, tag, or merge-base) along two axes: Standards (does the code follow this repo\'s documented coding standards?) and Spec (does the code match what the originating issue/spec asked for?). Runs both reviews in parallel sub-agents and reports them side by side. Use when the user wants to review a branch, a PR, work-in-progress changes, or asks to \\"review since X\\".',
    userInvoked: false,
  },
  {
    id: "resolving-merge-conflicts",
    label: "Resolving merge conflicts",
    description:
      "Use when you need to resolve an in-progress git merge/rebase conflict.",
    userInvoked: false,
  },
  {
    id: "wizard",
    label: "Wizard",
    description:
      "Generate an interactive bash wizard that walks a human through steps only they can perform. Use when provisioning infrastructure, setting up credentials or CI secrets, walking an unfamiliar third-party dashboard, or running a one-off migration or cutover. Don't invoke this for steps the agent can perform itself.",
    userInvoked: false,
  },
  {
    id: "grill-me",
    label: "Grill me",
    description: "A relentless interview to sharpen a plan or design.",
    userInvoked: true,
  },
  {
    id: "grilling",
    label: "Grilling",
    description:
      "Grill the user relentlessly about a plan, decision, or idea. Use when the user wants to stress-test their thinking, or uses any 'grill' trigger phrases.",
    userInvoked: false,
  },
  {
    id: "handoff",
    label: "Handoff",
    description:
      "Compact the current conversation into a handoff document for another agent to pick up.",
    userInvoked: true,
  },
  {
    id: "teach",
    label: "Teach",
    description:
      "Teach the user a new skill or concept, within this workspace.",
    userInvoked: true,
  },
  {
    id: "to-questionnaire",
    label: "To questionnaire",
    description:
      "Turn a decision you can't fully answer into a questionnaire for someone else to fill in.",
    userInvoked: true,
  },
  {
    id: "wait-what",
    label: "Wait what",
    description: "Stop. That last message did not land: re-pitch it.",
    userInvoked: true,
  },
  {
    id: "writing-for-agents",
    label: "Writing for agents",
    description:
      "Writing documents for agents. Use when creating or editing skills, or modifying AGENTS.md or CLAUDE.md.",
    userInvoked: false,
  },
] as const;
export const EXECUTOR_SKILL_REVISION =
  "3cca18b368ae95cdbdebbff572ccafa662551015";
export const ExecutorSkillIdSchema = z.enum([
  "ask-matt",
  "diagnosing-bugs",
  "grill-with-docs",
  "triage",
  "improve-codebase-architecture",
  "setup-matt-pocock-skills",
  "tdd",
  "to-spec",
  "to-tickets",
  "wayfinder",
  "implement",
  "prototype",
  "research",
  "domain-modeling",
  "codebase-design",
  "code-review",
  "resolving-merge-conflicts",
  "wizard",
  "grill-me",
  "grilling",
  "handoff",
  "teach",
  "to-questionnaire",
  "wait-what",
  "writing-for-agents",
]);
export type ExecutorSkillId = z.infer<typeof ExecutorSkillIdSchema>;
export const ExecutorSkillsSchema = z
  .array(ExecutorSkillIdSchema)
  .max(3)
  .refine(
    (ids) => new Set(ids).size === ids.length,
    "Choose each skill only once",
  );
export const ExecutorSkillReceiptSchema = z.strictObject({
  id: ExecutorSkillIdSchema,
  revision: z.string().regex(/^[a-f0-9]{40}$/),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
