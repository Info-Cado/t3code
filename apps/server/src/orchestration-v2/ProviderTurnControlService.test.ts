import { assert, it } from "@effect/vitest";
import {
  CheckpointScopeId,
  EventId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2DomainEvent,
  RuntimeRequestId,
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
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as IdAllocator from "./IdAllocator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import type { ProviderAdapterV2SessionRuntime } from "./ProviderAdapter.ts";
import * as ProviderEventIngestor from "./ProviderEventIngestor.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderTurnControlService from "./ProviderTurnControlService.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import * as TurnItemPositionStore from "./TurnItemPositionStore.ts";

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
    Layer.provide(
      Layer.mergeAll(
        projectionLayer,
        sessionManagerLayer,
        IdAllocator.layer,
        // These cases never end an orphaned run, which is what writes.
        Layer.mock(EventSink.EventSinkV2)({}),
        Layer.mock(ProviderEventIngestor.ProviderEventIngestorV2)({}),
      ),
    ),
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

function makeRuntime(input: {
  readonly now: DateTime.Utc;
  readonly providerSessionId: ProviderSessionId;
  readonly interruptTurn: ProviderAdapterV2SessionRuntime["interruptTurn"];
}): ProviderAdapterV2SessionRuntime {
  return {
    instanceId: providerInstanceId,
    driver,
    providerSessionId: input.providerSessionId,
    providerSession: {
      id: input.providerSessionId,
      driver,
      providerInstanceId,
      status: "running",
      cwd: "/workspace",
      model: modelSelection.model,
      capabilities: CodexProviderCapabilitiesV2,
      createdAt: input.now,
      updatedAt: input.now,
      lastError: null,
    },
    events: Stream.empty,
    ensureThread: () => Effect.die("unused ensureThread"),
    resumeThread: () => Effect.die("unused resumeThread"),
    startTurn: () => Effect.die("unused startTurn"),
    steerTurn: () => Effect.die("unused steerTurn"),
    interruptTurn: input.interruptTurn,
    respondToRuntimeRequest: () => Effect.die("unused respondToRuntimeRequest"),
    readThreadSnapshot: () => Effect.die("unused readThreadSnapshot"),
    rollbackThread: () => Effect.die("unused rollbackThread"),
    forkThread: () => Effect.die("unused forkThread"),
  };
}

// Stop on a turn its adapter reports no longer active waits for that turn's
// end to project, since its terminal went out when it settled. It does not
// wait on an adapter that reports nothing.
it.effect("waits for a settled turn's end only when its adapter no longer holds it", () =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const threadId = ThreadId.make("thread:settled-stop");
    const providerSessionId = ProviderSessionId.make("provider-session:settled-stop");
    const providerThreadId = ProviderThreadId.make("provider-thread:settled-stop");
    const providerTurnId = ProviderTurnId.make("provider-turn:settled-stop");
    const attemptId = RunAttemptId.make("run-attempt:settled-stop");
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
    const base = makeProjection({ now, threadId, providerThread, providerTurnId, attemptId });
    const runningProjection: OrchestrationV2ThreadProjection = {
      ...base,
      attempts: base.attempts.map(
        (attempt): OrchestrationV2ThreadProjection["attempts"][number] => ({
          ...attempt,
          status: "running",
          completedAt: null,
        }),
      ),
    };
    const stop = (scenario: {
      readonly outcome: "turn_not_active" | undefined;
      /** The control-context read on which the turn's end lands. */
      readonly terminalOnRead: number;
    }) =>
      Effect.gen(function* () {
        const projection = yield* Ref.make(runningProjection);
        const reads = yield* Ref.make(0);
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
        const runtime = makeRuntime({
          now,
          providerSessionId,
          interruptTurn: () => Effect.succeed(scenario.outcome),
        });
        yield* Effect.gen(function* () {
          const control = yield* ProviderTurnControlService.ProviderTurnControlServiceV2;
          yield* control.interrupt({
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
        return yield* Ref.get(reads);
      });

    // The turn's end lands on the third read, and Stop stops waiting there.
    assert.equal(yield* stop({ outcome: "turn_not_active", terminalOnRead: 3 }), 3);
    // An adapter that stopped a live turn (or cannot tell) is not waited on.
    assert.equal(yield* stop({ outcome: undefined, terminalOnRead: 3 }), 1);
  }),
);

const persistenceLayer = (() => {
  const database = SqlitePersistenceMemory;
  const stores = Layer.mergeAll(
    EventStore.layer,
    ProjectionStore.layer,
    ProjectStore.layer,
    CommandReceiptStore.layer,
    EffectOutbox.layer,
    TurnItemPositionStore.layer,
  ).pipe(Layer.provide(database));
  const eventSink = EventSink.layerFromStores.pipe(Layer.provide(Layer.mergeAll(stores, database)));
  const ingestor = ProviderEventIngestor.layer.pipe(
    Layer.provide(
      Layer.mergeAll(stores, eventSink, IdAllocator.layer, ThreadCommandExecutor.layer),
    ),
  );
  return Layer.mergeAll(database, stores, eventSink, ingestor, IdAllocator.layer);
})();

// Stop on a turn its adapter settled without the run ever seeing it end
// (#15197): no terminal will come, so Stop ends the run as its ingestion
// would have, and a terminal that turns up late cannot undo that.
it.effect("ends the run of a stopped turn its adapter settled unseen", () =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const threadId = ThreadId.make("thread:orphaned-stop");
    const providerSessionId = ProviderSessionId.make("provider-session:orphaned-stop");
    const providerThreadId = ProviderThreadId.make("provider-thread:orphaned-stop");
    const providerTurnId = ProviderTurnId.make("provider-turn:orphaned-stop");
    const attemptId = RunAttemptId.make("run-attempt:orphaned-stop");
    const runId = RunId.make("run:orphaned-stop");
    const rootNodeId = NodeId.make("node:orphaned-stop");
    const requestNodeId = NodeId.make("node:orphaned-stop:request");
    const requestId = RuntimeRequestId.make("request:orphaned-stop");
    const nativeSubagentId = NodeId.make("subagent:orphaned-stop:native");
    const appOwnedSubagentId = NodeId.make("subagent:orphaned-stop:app-owned");
    const common = { threadId, occurredAt: now };
    const subagent = (id: NodeId, origin: "provider_native" | "app_owned") =>
      ({
        ...common,
        id: EventId.make(`event:${id}`),
        type: "subagent.updated",
        runId,
        nodeId: id,
        driver,
        providerInstanceId,
        payload: {
          id,
          threadId,
          runId,
          parentNodeId: rootNodeId,
          origin,
          createdBy: "agent",
          driver,
          providerInstanceId,
          providerThreadId: origin === "provider_native" ? providerThreadId : null,
          childThreadId: null,
          nativeTaskRef: null,
          prompt: "Explore the codebase.",
          title: null,
          model: null,
          status: "running",
          result: null,
          startedAt: now,
          completedAt: null,
          updatedAt: now,
        },
      }) satisfies OrchestrationV2DomainEvent;
    const seed: ReadonlyArray<OrchestrationV2DomainEvent> = [
      {
        ...common,
        id: EventId.make("event:orphaned-stop:thread"),
        type: "thread.created",
        payload: {
          id: threadId,
          projectId: ProjectId.make("project:orphaned-stop"),
          title: "Orphaned stop",
          providerInstanceId,
          modelSelection,
          createdBy: "user",
          creationSource: "web",
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: "/workspace",
          activeProviderThreadId: providerThreadId,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      },
      {
        ...common,
        id: EventId.make("event:orphaned-stop:provider-thread"),
        type: "provider-thread.updated",
        payload: {
          id: providerThreadId,
          driver,
          providerInstanceId,
          providerSessionId,
          appThreadId: threadId,
          ownerNodeId: null,
          nativeThreadRef: { driver, nativeId: "native-thread:orphaned-stop", strength: "strong" },
          nativeConversationHeadRef: null,
          status: "active",
          firstRunOrdinal: 1,
          lastRunOrdinal: 1,
          handoffIds: [],
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
        },
      },
      {
        ...common,
        id: EventId.make("event:orphaned-stop:run"),
        type: "run.created",
        payload: {
          id: runId,
          threadId,
          ordinal: 1,
          providerInstanceId,
          modelSelection,
          providerThreadId,
          userMessageId: MessageId.make("message:orphaned-stop"),
          rootNodeId,
          activeAttemptId: attemptId,
          status: "running",
          requestedAt: now,
          startedAt: now,
          completedAt: null,
          checkpointId: null,
          contextHandoffId: null,
        },
      },
      {
        ...common,
        id: EventId.make("event:orphaned-stop:root-node"),
        type: "node.updated",
        runId,
        nodeId: rootNodeId,
        payload: {
          id: rootNodeId,
          threadId,
          runId,
          parentNodeId: null,
          rootNodeId,
          kind: "root_turn",
          status: "running",
          countsForRun: true,
          providerThreadId,
          providerTurnId,
          nativeItemRef: null,
          runtimeRequestId: null,
          checkpointScopeId: CheckpointScopeId.make("checkpoint-scope:orphaned-stop"),
          startedAt: now,
          completedAt: null,
        },
      },
      {
        ...common,
        id: EventId.make("event:orphaned-stop:attempt"),
        type: "run-attempt.created",
        payload: {
          id: attemptId,
          runId,
          attemptOrdinal: 1,
          rootNodeId,
          providerInstanceId,
          providerThreadId,
          providerTurnId,
          reason: "initial",
          status: "running",
          startedAt: now,
          completedAt: null,
        },
      },
      {
        ...common,
        id: EventId.make("event:orphaned-stop:turn"),
        type: "provider-turn.updated",
        nodeId: rootNodeId,
        payload: {
          id: providerTurnId,
          providerThreadId,
          nodeId: rootNodeId,
          runAttemptId: attemptId,
          nativeTurnRef: { driver, nativeId: "native-turn:orphaned-stop", strength: "strong" },
          ordinal: 1,
          status: "running",
          startedAt: now,
          completedAt: null,
        },
      },
      subagent(nativeSubagentId, "provider_native"),
      subagent(appOwnedSubagentId, "app_owned"),
      {
        ...common,
        id: EventId.make("event:orphaned-stop:request-node"),
        type: "node.updated",
        runId,
        nodeId: requestNodeId,
        payload: {
          id: requestNodeId,
          threadId,
          runId,
          parentNodeId: rootNodeId,
          rootNodeId,
          kind: "user_input_request",
          status: "waiting",
          countsForRun: false,
          providerThreadId,
          providerTurnId,
          nativeItemRef: null,
          runtimeRequestId: requestId,
          checkpointScopeId: null,
          startedAt: now,
          completedAt: null,
        },
      },
      {
        ...common,
        id: EventId.make("event:orphaned-stop:request"),
        type: "runtime-request.updated",
        nodeId: requestNodeId,
        payload: {
          id: requestId,
          nodeId: requestNodeId,
          providerTurnId,
          nativeRequestRef: null,
          kind: "user_input",
          status: "pending",
          responseCapability: { type: "live", providerSessionId },
          createdAt: now,
          resolvedAt: null,
        },
      },
    ];
    yield* Effect.forEach(seed, (event) => projections.apply(event), { discard: true });

    const runtime = makeRuntime({
      now,
      providerSessionId,
      interruptTurn: () => Effect.succeed("turn_not_active" as const),
    });
    yield* Effect.gen(function* () {
      const control = yield* ProviderTurnControlService.ProviderTurnControlServiceV2;
      yield* control.interrupt({ threadId, providerSessionId, providerThreadId, providerTurnId });
    }).pipe(
      Effect.provide(
        ProviderTurnControlService.layer.pipe(
          Layer.provide(
            Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
              get: (id) =>
                Effect.succeed(id === providerSessionId ? Option.some(runtime) : Option.none()),
            }),
          ),
        ),
      ),
    );

    const statuses = Effect.gen(function* () {
      const projection = yield* projections.getThreadProjection(threadId);
      return {
        run: projection.runs.find((run) => run.id === runId)?.status,
        attempt: projection.attempts.find((attempt) => attempt.id === attemptId)?.status,
        providerTurn: projection.providerTurns.find((turn) => turn.id === providerTurnId)?.status,
        rootNode: projection.nodes.find((node) => node.id === rootNodeId)?.status,
        nativeSubagent: projection.subagents.find((item) => item.id === nativeSubagentId)?.status,
        appOwnedSubagent: projection.subagents.find((item) => item.id === appOwnedSubagentId)
          ?.status,
        request: projection.runtimeRequests.find((request) => request.id === requestId)?.status,
        interruptResult: projection.turnItems.some(
          (item) => item.runId === runId && item.type === "run_interrupt_result",
        ),
      };
    });
    const ended = {
      run: "interrupted",
      attempt: "interrupted",
      providerTurn: "interrupted",
      rootNode: "interrupted",
      nativeSubagent: "interrupted",
      // An app-owned subagent runs on its own run and session.
      appOwnedSubagent: "running",
      request: "cancelled",
      interruptResult: true,
    } as const;
    assert.deepEqual(yield* statuses, ended);
    assert.isTrue(
      Option.isSome(yield* outbox.get(`effect:checkpoint.capture:${runId}`)),
      "the stopped run captures its checkpoint",
    );

    // A terminal that turns up after Stop ended the run is written only while
    // the run still runs that attempt, as run execution now writes it.
    const late = yield* eventSink.writeIfRunCurrent({
      threadId,
      runId,
      activeAttemptId: attemptId,
      expectedStatus: ["starting", "running"],
      events: [
        {
          ...common,
          id: EventId.make("event:orphaned-stop:late-run"),
          type: "run.updated",
          runId,
          payload: {
            ...(yield* projections.getThreadProjection(threadId)).runs[0]!,
            status: "waiting",
            completedAt: null,
          },
        },
      ],
    });
    assert.isFalse(late.committed);
    assert.deepEqual(yield* statuses, ended);
  }).pipe(Effect.provide(persistenceLayer)),
);
