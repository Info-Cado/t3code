import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import {
  latestOrchestratorAgents,
  orchestratorTurnContext,
  previousTurnStart,
  withOrchestratorTurnContext,
} from "./orchestratorTurnContext.ts";
import { ProjectionStoreReadError } from "./ProjectionStore.ts";

const task = (
  childThreadId: string | null,
  status: "running" | "completed",
  title: string | null = "Task",
  origin: "app_owned" | "provider_native" = "app_owned",
) =>
  ({
    childThreadId: childThreadId === null ? null : ThreadId.make(childThreadId),
    origin,
    status,
    title,
  }) as never;

it("lists each agent once at its latest task, unfinished work first", () => {
  const agents = latestOrchestratorAgents([
    task("thread:a", "completed", "First try"),
    task("thread:b", "completed", "Done"),
    task("thread:native", "running", "Native", "provider_native"),
    task(null, "running", "Remote"),
    task("thread:a", "running", "Second try"),
    task("thread:c", "completed", "Newest done"),
  ]);

  assert.deepEqual(
    agents.map((agent) => [agent.threadId, agent.status, agent.title]),
    [
      ["thread:a", "running", "Second try"],
      ["thread:c", "completed", "Newest done"],
      ["thread:b", "completed", "Done"],
    ],
  );
});

it("says what the user wrote to an agent, shortened, under that agent", () => {
  const context = orchestratorTurnContext({
    agents: [{ threadId: ThreadId.make("thread:a"), status: "running", title: "Fix it" }],
    notes: [
      { threadId: ThreadId.make("thread:a"), text: "Use the existing table." },
      { threadId: ThreadId.make("thread:a"), text: "x".repeat(500) },
      { threadId: ThreadId.make("thread:gone"), text: "Not one of the agents shown." },
    ],
  });

  assert.include(context, `- thread:a running "Fix it"`);
  assert.include(context, `The user wrote to it directly: "Use the existing table."`);
  assert.include(context, `${"x".repeat(200)}…"`);
  assert.notInclude(context, "Not one of the agents shown.");
  assert.isTrue(context.startsWith("<t3_orchestrator>"));
});

it("caps the list and fits in one Codex instruction entry", () => {
  const context = orchestratorTurnContext({
    agents: Array.from({ length: 30 }, (_, index) => ({
      threadId: ThreadId.make(`thread:${index}`),
      status: "completed",
      title: `Agent ${index}`,
    })),
    notes: [],
  });

  assert.include(context, "and 10 older.");
  assert.notInclude(context, "thread:25");
  assert.isBelow(Buffer.byteLength(context), 4_000);
});

it("reads news since the turn before this one", () => {
  const earlier = DateTime.makeUnsafe("2026-11-05T10:00:00.000Z");
  const runs = [
    { id: "run:1", startedAt: earlier },
    { id: "run:queued", startedAt: null },
    { id: "run:now", startedAt: DateTime.makeUnsafe("2026-11-05T11:00:00.000Z") },
  ] as never;

  assert.equal(previousTurnStart(runs, "run:now" as never), earlier);
  assert.isNull(
    previousTurnStart([{ id: "run:now", startedAt: null }] as never, "run:now" as never),
  );
});

const threadId = ThreadId.make("thread:orchestrator");
const store = (overrides?: { readonly failing?: boolean }) =>
  ({
    getThreadRecords: () =>
      overrides?.failing === true
        ? Effect.fail(new ProjectionStoreReadError({ threadId }))
        : Effect.succeed({ subagents: [task("thread:a", "running", "Fix it")] }),
    listUserMessagesInChildThreads: () =>
      Effect.succeed([{ threadId: ThreadId.make("thread:a"), text: "Use the existing table." }]),
  }) as never;

it.effect("sends the context ahead of the message and leaves native commands alone", () =>
  Effect.gen(function* () {
    const since = DateTime.makeUnsafe("2026-11-05T10:00:00.000Z");
    const sent = yield* withOrchestratorTurnContext("Fix the bug", {
      store: store(),
      threadId,
      since,
    });
    assert.isTrue(sent.endsWith("</t3_orchestrator>\n\nFix the bug"));
    assert.include(sent, "Use the existing table.");

    assert.equal(
      yield* withOrchestratorTurnContext("/compact", { store: store(), threadId, since }),
      "/compact",
    );
  }),
);

it.effect("still sends the message when the context cannot be read", () =>
  Effect.gen(function* () {
    assert.equal(
      yield* withOrchestratorTurnContext("Fix the bug", {
        store: store({ failing: true }),
        threadId,
        since: null,
      }),
      "Fix the bug",
    );
  }),
);
