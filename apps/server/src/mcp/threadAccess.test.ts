import { expect, it } from "@effect/vitest";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import { liveThreadShell } from "./McpToolAccess.testkit.ts";
import { assertOrchestratorOwnsTarget, readThread } from "./threadAccess.ts";

const bareId = ThreadId.make("5d0b4a3e-8c1f-4a52-9d37-2f6c7e1b9a04");
const client: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:thread-access"),
  requestNamespace: "client:thread-access",
  thread: undefined,
  client: { sessionId: "thread-access", label: "Claude Code", access: "full-access" },
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

const readBare = (existing: ReadonlyArray<ThreadId>) =>
  readThread(bareId).pipe(
    Effect.flip,
    Effect.provideService(McpInvocationContext.McpInvocationContext, client),
    Effect.provide(
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: (threadId) =>
          Effect.succeed(existing.includes(threadId) ? liveThreadShell(threadId) : null),
      }),
    ),
  );

it.effect("keeps an orchestrator to its own agents; other callers are not limited", () =>
  Effect.gen(function* () {
    const shell = liveThreadShell(ThreadId.make("thread:orchestrator"));
    const orchestrator = { caller: { ...shell, agentRole: "orchestrator" as const } };
    const lineage = (rootThreadId: string, relationshipToParent: "subagent" | "fork" | null) => ({
      lineage: {
        parentThreadId: null,
        relationshipToParent,
        rootThreadId: ThreadId.make(rootThreadId),
      },
    });

    yield* assertOrchestratorOwnsTarget(orchestrator, lineage("thread:orchestrator", "subagent"));
    yield* assertOrchestratorOwnsTarget({ caller: shell }, lineage("thread:users-own", null));
    yield* assertOrchestratorOwnsTarget({ caller: undefined }, lineage("thread:users-own", null));
    for (const target of [
      lineage("thread:users-own", null),
      // A fork of the orchestrator keeps its root, and it is the user's.
      lineage("thread:orchestrator", "fork"),
    ]) {
      const refused = yield* assertOrchestratorOwnsTarget(orchestrator, target).pipe(Effect.flip);
      expect(refused.code).toBe("capability_denied");
    }
  }),
);

it.effect("points a bare uuid at the mcp: thread it belongs to", () =>
  Effect.gen(function* () {
    const error = yield* readBare([ThreadId.make(`mcp:${bareId}`)]);

    expect(error.code).toBe("thread_not_found");
    expect(error.message).toBe(`The thread was not found. Did you mean \`mcp:${bareId}\`?`);
  }),
);
