import { assert, it } from "@effect/vitest";
import {
  type ModelSelection,
  NodeId,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import type { ProviderAdapterV2SessionRuntime } from "./ProviderAdapter.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderTurnControlService from "./ProviderTurnControlService.ts";

const driver = ProviderDriverKind.make("codex");
const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = {
  instanceId: providerInstanceId,
  model: "gpt-5.4",
} satisfies ModelSelection;

function makeProjection(input: {
  readonly now: DateTime.Utc;
  readonly threadId: ThreadId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly providerTurnId: ProviderTurnId;
  readonly attemptId: RunAttemptId;
}): OrchestrationV2ThreadProjection {
  const runId = RunId.make("run:restart-session");
  const nodeId = NodeId.make("node:restart-session");
  return {
    thread: {
      createdBy: "user",
      creationSource: "web",
      id: input.threadId,
      projectId: ProjectId.make("project:restart-session"),
      title: "Restart session",
      providerInstanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: "/workspace",
      activeProviderThreadId: input.providerThread.id,
      lineage: {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId: input.threadId,
      },
      forkedFrom: null,
      createdAt: input.now,
      updatedAt: input.now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
    runs: [],
    attempts: [
      {
        id: input.attemptId,
        runId,
        attemptOrdinal: 1,
        rootNodeId: nodeId,
        providerInstanceId,
        providerThreadId: input.providerThread.id,
        providerTurnId: input.providerTurnId,
        reason: "initial",
        status: "superseded",
        startedAt: input.now,
        completedAt: input.now,
      },
    ],
    nodes: [],
    subagents: [],
    providerSessions: [],
    providerThreads: [input.providerThread],
    providerTurns: [
      {
        id: input.providerTurnId,
        providerThreadId: input.providerThread.id,
        nodeId,
        runAttemptId: input.attemptId,
        nativeTurnRef: {
          driver,
          nativeId: "native-turn:restart-session",
          strength: "strong",
        },
        ordinal: 1,
        status: "running",
        startedAt: input.now,
        completedAt: null,
      },
    ],
    runtimeRequests: [],
    messages: [],
    plans: [],
    turnItems: [],
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems: [],
    updatedAt: input.now,
  };
}

function makeControlLayer(input: {
  readonly projection: Ref.Ref<OrchestrationV2ThreadProjection>;
  readonly runtime: ProviderAdapterV2SessionRuntime;
  readonly providerSessionId: ProviderSessionId;
  /** Runs before each control-context read, as projection writes landing between reads. */
  readonly beforeControlRead?: Effect.Effect<void>;
}) {
  const { projection, runtime } = input;
  const projectionLayer = Layer.succeed(
    ProjectionStore.ProjectionStoreV2,
    ProjectionStore.ProjectionStoreV2.of({
      apply: () => Effect.void,
      getLimitRecoveryCandidates: () => Effect.die("unused getLimitRecoveryCandidates"),
      getShellSnapshot: () => Effect.die("unused getShellSnapshot"),
      getThreadShell: () => Effect.die("unused getThreadShell"),
      getThread: () => Ref.get(projection).pipe(Effect.map((state) => state.thread)),
      getSettlementCandidates: () => Effect.die("unused getSettlementCandidates"),
      getThreadsWithPullRequests: () => Effect.die("unused getThreadsWithPullRequests"),
      getThreadProjection: () => Effect.die("control effects must not load transcript"),
      getTurnStartContext: () => Effect.die("unused"),
      getTurnStartHistory: () => Effect.die("unused"),
      getRuntimeRecoveryProjection: () => Effect.die("unused getRuntimeRecoveryProjection"),
      getPlan: () => Effect.die("unused"),
      hasUnpairedRunInterruptRequest: () => Effect.die("unused interrupt read"),
      getThreadAttachmentIds: () => Effect.die("Unused attachment lookup"),
      getTimelinePage: () => Effect.die("Unused timeline read"),
      getMessageCount: () => Effect.die("unused message count"),
      getNextTurnItemOrdinal: () => Effect.die("unused ordinal read"),
      getThreadRecords: () => Effect.die("unused record read"),
      getRuntimeRequest: () => Effect.die("unused getRuntimeRequest"),
      getRunningTurnContext: () => Effect.die("unused getRunningTurnContext"),
      getThreadProviderContext: () => Effect.die("unused getThreadProviderContext"),
      getRuntimeResponseContext: () => Effect.die("unused getRuntimeResponseContext"),
      getPendingNativeUserInputs: () => Effect.die("unused getPendingNativeUserInputs"),
      getProviderControlContext: (_threadId, target) =>
        (input.beforeControlRead ?? Effect.void).pipe(
          Effect.andThen(Ref.get(projection)),
          Effect.map((current) => ({
            providerThread: current.providerThreads.find(
              (thread) => thread.id === target.providerThreadId,
            ),
            providerTurn: current.providerTurns.find((turn) => turn.id === target.providerTurnId),
            attempt: current.attempts.find((attempt) => attempt.id === target.attemptId),
            message: undefined,
            run: undefined,
          })),
        ),
      getCheckpointContext: () => Effect.die("not used"),
      getCheckpointCaptureContext: () => Effect.die("not used"),
      getRunMessage: () => Effect.die("not used"),
      canStartQueuedRun: () => Effect.die("not used"),
      getRecoveryThreadIds: () => Effect.die("unused getRecoveryThreadIds"),
      getUnreadableThreadIds: () => Effect.die("unused getUnreadableThreadIds"),
      getThreadSnapshot: () => Effect.die("unused getThreadSnapshot"),
      getThreadSnapshotWindow: () => Effect.die("unused getThreadSnapshotWindow"),
    }),
  );
  const sessionManagerLayer = Layer.succeed(
    ProviderSessionManager.ProviderSessionManagerV2,
    ProviderSessionManager.ProviderSessionManagerV2.of({
      shutdown: Effect.void,
      open: () => Effect.die("unused open"),
      get: (providerSessionId) =>
        Effect.succeed(
          providerSessionId === input.providerSessionId ? Option.some(runtime) : Option.none(),
        ),
      close: () => Effect.void,
      closeInstance: () => Effect.void,
      release: () => Effect.void,
      detach: () => Effect.void,
    }),
  );
  return ProviderTurnControlService.layer.pipe(
    Layer.provide(Layer.merge(projectionLayer, sessionManagerLayer)),
  );
}

it.effect(
  "interrupts the historical session only for the exact committed restart replacement",
  () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:restart-session");
      const oldSessionId = ProviderSessionId.make("provider-session:restart-session:old");
      const replacementSessionId = ProviderSessionId.make(
        "provider-session:restart-session:replacement",
      );
      const unrelatedSessionId = ProviderSessionId.make(
        "provider-session:restart-session:unrelated",
      );
      const providerThreadId = ProviderThreadId.make("provider-thread:restart-session");
      const providerTurnId = ProviderTurnId.make("provider-turn:restart-session");
      const attemptId = RunAttemptId.make("run-attempt:restart-session");
      const providerThread: OrchestrationV2ProviderThread = {
        id: providerThreadId,
        driver,
        providerInstanceId,
        // The restart command has already projected this replacement binding
        // before the process-bound restart effect executes.
        providerSessionId: replacementSessionId,
        appThreadId: threadId,
        ownerNodeId: null,
        nativeThreadRef: {
          driver,
          nativeId: "native-thread:restart-session",
          strength: "strong",
        },
        nativeConversationHeadRef: null,
        status: "not_loaded",
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      };
      const projection = yield* Ref.make(
        makeProjection({ now, threadId, providerThread, providerTurnId, attemptId }),
      );
      const interruptedThread = yield* Ref.make<OrchestrationV2ProviderThread | null>(null);
      const providerSession = {
        id: oldSessionId,
        driver,
        providerInstanceId,
        status: "running" as const,
        cwd: "/workspace",
        model: modelSelection.model,
        capabilities: CodexProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      };
      const runtime: ProviderAdapterV2SessionRuntime = {
        instanceId: providerInstanceId,
        driver,
        providerSessionId: oldSessionId,
        providerSession,
        events: Stream.empty,
        ensureThread: () => Effect.die("unused ensureThread"),
        resumeThread: () => Effect.die("unused resumeThread"),
        startTurn: () => Effect.die("unused startTurn"),
        steerTurn: () => Effect.die("unused steerTurn"),
        interruptTurn: ({ providerThread: target }) =>
          Effect.all(
            [
              Ref.set(interruptedThread, target),
              Ref.update(projection, (current) => ({
                ...current,
                providerTurns: current.providerTurns.map((turn) =>
                  turn.id === providerTurnId
                    ? { ...turn, status: "interrupted" as const, completedAt: now }
                    : turn,
                ),
              })),
            ],
            { discard: true },
          ),
        respondToRuntimeRequest: () => Effect.die("unused respondToRuntimeRequest"),
        readThreadSnapshot: () => Effect.die("unused readThreadSnapshot"),
        rollbackThread: () => Effect.die("unused rollbackThread"),
        forkThread: () => Effect.die("unused forkThread"),
      };
      const controlLayer = makeControlLayer({
        projection,
        runtime,
        providerSessionId: oldSessionId,
      });

      const [ordinaryInterrupt, unrelatedRestart] = yield* Effect.gen(function* () {
        const control = yield* ProviderTurnControlService.ProviderTurnControlServiceV2;
        const ordinary = yield* Effect.exit(
          control.interrupt({
            threadId,
            providerSessionId: oldSessionId,
            providerThreadId,
            providerTurnId,
          }),
        );
        const unrelated = yield* Effect.exit(
          control.interruptAndAwaitTerminal({
            threadId,
            providerSessionId: oldSessionId,
            replacementProviderSessionId: unrelatedSessionId,
            providerThreadId,
            providerTurnId,
            interruptedAttemptId: attemptId,
          }),
        );
        return [ordinary, unrelated] as const;
      }).pipe(Effect.provide(controlLayer));

      assert.isTrue(Exit.isFailure(ordinaryInterrupt));
      assert.isTrue(Exit.isFailure(unrelatedRestart));
      assert.isNull(yield* Ref.get(interruptedThread));

      yield* Effect.gen(function* () {
        const control = yield* ProviderTurnControlService.ProviderTurnControlServiceV2;
        yield* control.interruptAndAwaitTerminal({
          threadId,
          providerSessionId: oldSessionId,
          replacementProviderSessionId: replacementSessionId,
          providerThreadId,
          providerTurnId,
          interruptedAttemptId: attemptId,
        });
      }).pipe(Effect.provide(controlLayer));

      const interrupted = yield* Ref.get(interruptedThread);
      assert.isNotNull(interrupted);
      assert.equal(interrupted?.providerSessionId, oldSessionId);
      assert.equal(interrupted?.id, providerThreadId);
      assert.equal(interrupted?.nativeThreadRef?.nativeId, "native-thread:restart-session");
    }),
);

// Stop on a turn its adapter no longer holds: its terminal was emitted when it
// settled, so it is orphaned only if that end still has not projected (#15197).
it.effect("reports a stopped turn orphaned only when its adapter settled it unseen", () =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const threadId = ThreadId.make("thread:orphaned-stop");
    const providerSessionId = ProviderSessionId.make("provider-session:orphaned-stop");
    const providerThreadId = ProviderThreadId.make("provider-thread:orphaned-stop");
    const providerTurnId = ProviderTurnId.make("provider-turn:orphaned-stop");
    const attemptId = RunAttemptId.make("run-attempt:orphaned-stop");
    const providerThread: OrchestrationV2ProviderThread = {
      id: providerThreadId,
      driver,
      providerInstanceId,
      providerSessionId,
      appThreadId: threadId,
      ownerNodeId: null,
      nativeThreadRef: null,
      nativeConversationHeadRef: null,
      status: "active",
      firstRunOrdinal: 1,
      lastRunOrdinal: 1,
      handoffIds: [],
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
    };
    const runningProjection: OrchestrationV2ThreadProjection = (() => {
      const projection = makeProjection({
        now,
        threadId,
        providerThread,
        providerTurnId,
        attemptId,
      });
      return {
        ...projection,
        attempts: projection.attempts.map(
          (attempt): OrchestrationV2ThreadProjection["attempts"][number] => ({
            ...attempt,
            status: "running",
            completedAt: null,
          }),
        ),
      };
    })();
    const interruptStop = (scenario: {
      readonly outcome: "turn_not_active" | undefined;
      /** The control-context read on which the turn's terminal lands. */
      readonly terminalOnRead?: number;
    }) =>
      Effect.gen(function* () {
        const projection = yield* Ref.make(runningProjection);
        const reads = yield* Ref.make(0);
        const runtime: ProviderAdapterV2SessionRuntime = {
          instanceId: providerInstanceId,
          driver,
          providerSessionId,
          providerSession: {
            id: providerSessionId,
            driver,
            providerInstanceId,
            status: "running",
            cwd: "/workspace",
            model: modelSelection.model,
            capabilities: CodexProviderCapabilitiesV2,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
          events: Stream.empty,
          ensureThread: () => Effect.die("unused ensureThread"),
          resumeThread: () => Effect.die("unused resumeThread"),
          startTurn: () => Effect.die("unused startTurn"),
          steerTurn: () => Effect.die("unused steerTurn"),
          interruptTurn: () => Effect.succeed(scenario.outcome),
          respondToRuntimeRequest: () => Effect.die("unused respondToRuntimeRequest"),
          readThreadSnapshot: () => Effect.die("unused readThreadSnapshot"),
          rollbackThread: () => Effect.die("unused rollbackThread"),
          forkThread: () => Effect.die("unused forkThread"),
        };
        const beforeControlRead = Ref.updateAndGet(reads, (count) => count + 1).pipe(
          Effect.flatMap((count) =>
            count === scenario.terminalOnRead
              ? Ref.update(projection, (current) => ({
                  ...current,
                  providerTurns: current.providerTurns.map((turn) => ({
                    ...turn,
                    status: "completed" as const,
                    completedAt: now,
                  })),
                  attempts: current.attempts.map((attempt) => ({
                    ...attempt,
                    status: "completed" as const,
                    completedAt: now,
                  })),
                }))
              : Effect.void,
          ),
        );
        const result = yield* Effect.gen(function* () {
          const control = yield* ProviderTurnControlService.ProviderTurnControlServiceV2;
          return yield* control.interrupt({
            threadId,
            providerSessionId,
            providerThreadId,
            providerTurnId,
          });
        }).pipe(
          Effect.provide(
            makeControlLayer({ projection, runtime, providerSessionId, beforeControlRead }),
          ),
        );
        return { turnOrphaned: result.turnOrphaned, reads: yield* Ref.get(reads) };
      });

    // The adapter settled the turn, and its end never projects.
    const orphaned = yield* interruptStop({ outcome: "turn_not_active" });
    assert.isTrue(orphaned.turnOrphaned);
    // The adapter settled the turn and its end projects while Stop waits.
    assert.deepEqual(yield* interruptStop({ outcome: "turn_not_active", terminalOnRead: 3 }), {
      turnOrphaned: false,
      reads: 3,
    });
    // An adapter that stopped a live turn (or cannot tell) reports nothing, and
    // Stop does not wait on its terminal.
    assert.deepEqual(yield* interruptStop({ outcome: undefined }), {
      turnOrphaned: false,
      reads: 1,
    });
  }),
);
