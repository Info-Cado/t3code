import type { OrchestrationV2Run, OrchestrationV2Subagent, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type { ProjectionStoreV2Shape } from "./ProjectionStore.ts";

const ROLE = `You are this project's orchestrator. These rules replace the T3 Code orchestration rules where they differ.
- The user tells you everything about this project. Keep the plan and what matters in mind, and report briefly.
- You change nothing yourself. Send all work, including small fixes and reviews, to agents with \`delegate_task\`. Use \`isolation:"worktree"\` for work that edits files. Never use your provider's built-in subagents: the user cannot message those.
- Write each agent a complete brief: the goal, what you know, where to look, and when it is done. It sees nothing else.
- Have a new agent review finished work before you call it done.
- End your turn while agents run. Each one wakes you when it ends. Do not poll.
- The user can write to any agent, and their word wins over your brief. Threads that are not your agents are the user's own: read them only when asked, and do not report on them.
- Ask the user only for decisions that are theirs.`;

const MAX_AGENTS = 20;
const MAX_NOTES = 10;
const MAX_NOTE_LENGTH = 200;

const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

export interface OrchestratorAgent {
  readonly threadId: ThreadId;
  readonly title: string;
  readonly status: string;
}

export interface OrchestratorUserNote {
  readonly threadId: ThreadId;
  readonly text: string;
}

/** Each agent once, at its latest task: unfinished work first, then the most recent. */
export function latestOrchestratorAgents(
  tasks: ReadonlyArray<
    Pick<OrchestrationV2Subagent, "childThreadId" | "origin" | "status" | "title">
  >,
): ReadonlyArray<OrchestratorAgent> {
  const byThread = new Map<ThreadId, OrchestratorAgent>();
  for (const task of tasks) {
    if (task.origin !== "app_owned" || task.childThreadId === null) continue;
    byThread.delete(task.childThreadId);
    byThread.set(task.childThreadId, {
      threadId: task.childThreadId,
      title: task.title ?? "Agent",
      status: task.status,
    });
  }
  const newestFirst = [...byThread.values()].toReversed();
  return [
    ...newestFirst.filter((agent) => !TERMINAL_STATUSES.has(agent.status)),
    ...newestFirst.filter((agent) => TERMINAL_STATUSES.has(agent.status)),
  ];
}

/** What the server knows and the agent may not remember, such as after its chat was compacted. */
export function orchestratorTurnContext(input: {
  readonly agents: ReadonlyArray<OrchestratorAgent>;
  readonly notes: ReadonlyArray<OrchestratorUserNote>;
}): string {
  const shown = input.agents.slice(0, MAX_AGENTS);
  const lines = shown.flatMap((agent) => [
    `- ${agent.threadId} ${agent.status} ${JSON.stringify(agent.title)}`,
    ...input.notes
      .filter((note) => note.threadId === agent.threadId)
      .map((note) => `  The user wrote to it directly: ${JSON.stringify(shortNote(note.text))}`),
  ]);
  const older = input.agents.length - shown.length;
  const roster =
    lines.length === 0
      ? "You have no agents yet."
      : [
          "Your agents (thread id, status, title):",
          ...lines,
          ...(older > 0 ? [`and ${older} older.`] : []),
        ].join("\n");
  return `<t3_orchestrator>\n${ROLE}\n\n${roster}\n</t3_orchestrator>`;
}

const shortNote = (text: string): string =>
  text.length <= MAX_NOTE_LENGTH ? text : `${text.slice(0, MAX_NOTE_LENGTH)}…`;

/** When the turn before this one started: what the user wrote after that is news to the agent. */
export function previousTurnStart(
  runs: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "startedAt">>,
  runId: OrchestrationV2Run["id"],
): DateTime.Utc | null {
  return runs.findLast((run) => run.id !== runId && run.startedAt !== null)?.startedAt ?? null;
}

/**
 * Sent with each turn rather than in the system prompt, so one site covers every provider, it
 * survives compaction, and the stored message stays what its author wrote. Native commands such as
 * /compact must stay at the start of the prompt, so they go as they are.
 */
export const withOrchestratorTurnContext = Effect.fn("orchestrationV2.orchestratorTurnContext")(
  function* (
    text: string,
    input: {
      readonly store: Pick<
        ProjectionStoreV2Shape,
        "getThreadRecords" | "listUserMessagesInChildThreads"
      >;
      readonly threadId: ThreadId;
      readonly since: DateTime.Utc | null;
    },
  ) {
    if (text.trimStart().startsWith("/")) return text;
    const { subagents } = yield* input.store.getThreadRecords(input.threadId, ["subagents"]);
    const notes =
      input.since === null
        ? []
        : yield* input.store.listUserMessagesInChildThreads({
            threadId: input.threadId,
            since: DateTime.formatIso(input.since),
            limit: MAX_NOTES,
          });
    const context = orchestratorTurnContext({
      agents: latestOrchestratorAgents(subagents),
      notes,
    });
    return `${context}\n\n${text}`;
  },
  // This is help for the turn, so a failed read must not cost the user their turn.
  (effect, text) =>
    effect.pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Could not build the orchestrator's turn context", { cause }).pipe(
          Effect.as(text),
        ),
      ),
    ),
);
