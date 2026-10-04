import { projectComposerContextForProvider } from "@t3tools/shared/composerContextReferences";
import {
  MessageId,
  type OrchestrationV2ProviderTurn,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "./IdAllocator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderEventIngestor from "./ProviderEventIngestor.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as RunExecutionService from "./RunExecutionService.ts";

const yieldToRuntime = Effect.yieldNow.pipe(
  Effect.andThen(
    Effect.promise(
      () =>
        new Promise<void>((resolve) => {
          setImmediate(resolve);
        }),
    ),
  ),
);

export class ProviderTurnControlError extends Schema.TaggedError<ProviderTurnControlError>()(
  "ProviderTurnControlError",
  {
    threadId: ThreadId,
    operation: Schema.Literals(["interrupt", "restart", "steer"]),
    providerTurnId: ProviderTurnId,
    turnCompleted: Schema.optional(Schema.Boolean),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const isProviderTurnControlError = Schema.is(ProviderTurnControlError);

export interface ProviderTurnControlServiceV2Shape {
  readonly interrupt: (input: {
    readonly threadId: ThreadId;
    readonly providerSessionId: ProviderSessionId;
    readonly providerThreadId: ProviderThreadId;
    readonly providerTurnId: ProviderTurnId;
  }) => Effect.Effect<void, ProviderTurnControlError>;
  readonly steer: (input: {
    readonly threadId: ThreadId;
    readonly providerSessionId: ProviderSessionId;
    readonly providerThreadId: ProviderThreadId;
    readonly providerTurnId: ProviderTurnId;
    readonly messageId: MessageId;
  }) => Effect.Effect<void, ProviderTurnControlError>;
  readonly interruptAndAwaitTerminal: (input: {
    readonly threadId: ThreadId;
    readonly providerSessionId: ProviderSessionId;
    readonly replacementProviderSessionId?: ProviderSessionId;
    readonly providerThreadId: ProviderThreadId;
    readonly providerTurnId: ProviderTurnId;
    readonly interruptedAttemptId: RunAttemptId;
  }) => Effect.Effect<void, ProviderTurnControlError>;
}

export class ProviderTurnControlServiceV2 extends Context.Service<
  ProviderTurnControlServiceV2,
  ProviderTurnControlServiceV2Shape
>()("t3/orchestration-v2/ProviderTurnControlService/ProviderTurnControlServiceV2") {}

export const layer: Layer.Layer<
  ProviderTurnControlServiceV2,
  never,
  | EventSink.EventSinkV2
  | IdAllocator.IdAllocatorV2
  | ProjectionStore.ProjectionStoreV2
  | ProviderEventIngestor.ProviderEventIngestorV2
  | ProviderSessionManager.ProviderSessionManagerV2
> = Layer.effect(
  ProviderTurnControlServiceV2,
  Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const providerEventIngestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
    const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;

    const load = (input: {
      readonly threadId: ThreadId;
      readonly providerSessionId: ProviderSessionId;
      readonly replacementProviderSessionId?: ProviderSessionId;
      readonly providerThreadId: ProviderThreadId;
      readonly providerTurnId: ProviderTurnId;
      readonly operation: "interrupt" | "restart" | "steer";
      readonly messageId?: MessageId;
    }) =>
      Effect.gen(function* () {
        const context = yield* projections.getProviderControlContext(input.threadId, input);
        const { providerThread, providerTurn } = context;
        const targetsRecordedSession =
          providerThread?.providerSessionId === input.providerSessionId;
        const targetsCommittedReplacement =
          input.operation === "restart" &&
          input.replacementProviderSessionId !== undefined &&
          providerThread?.providerSessionId === input.replacementProviderSessionId;
        if (
          providerThread === undefined ||
          providerTurn === undefined ||
          (!targetsRecordedSession && !targetsCommittedReplacement) ||
          providerTurn.providerThreadId !== providerThread.id
        ) {
          return yield* new ProviderTurnControlError({
            threadId: input.threadId,
            operation: input.operation,
            providerTurnId: input.providerTurnId,
            cause: "The recorded provider execution target is no longer valid.",
          });
        }
        // A restart-session command commits the replacement binding before its
        // process-bound effect runs. The old live runtime must still receive
        // the interrupt, but only when the projection matches the exact
        // replacement captured by that same durable effect.
        const interruptProviderThread = targetsRecordedSession
          ? providerThread
          : { ...providerThread, providerSessionId: input.providerSessionId };
        if (providerTurn.status !== "running") {
          if (input.operation === "steer") {
            return yield* new ProviderTurnControlError({
              threadId: input.threadId,
              operation: "steer",
              providerTurnId: input.providerTurnId,
              turnCompleted: providerTurn.status === "completed",
              cause: "The provider turn ended before the steering message was delivered.",
            });
          }
          return {
            context,
            providerThread: interruptProviderThread,
            providerTurn,
            session: Option.none(),
          };
        }
        const session = yield* sessions.get(input.providerSessionId);
        if (Option.isNone(session)) {
          // Interrupt/restart against a already-released session must not fail
          // the durable effect (and retry 5x). The turn may still look running
          // in projection until recovery/finalization; there is no live adapter
          // to interrupt.
          if (input.operation === "interrupt" || input.operation === "restart") {
            yield* Effect.logWarning(
              "Provider interrupt/restart found no live session; treating as already stopped",
              {
                threadId: input.threadId,
                operation: input.operation,
                providerSessionId: input.providerSessionId,
                providerTurnId: input.providerTurnId,
                providerTurnStatus: providerTurn.status,
              },
            );
            return {
              context,
              providerThread: interruptProviderThread,
              providerTurn,
              session: Option.none(),
            };
          }
          return yield* new ProviderTurnControlError({
            threadId: input.threadId,
            operation: input.operation,
            providerTurnId: input.providerTurnId,
            cause: `Provider session ${input.providerSessionId} is not active.`,
          });
        }
        return { context, providerThread: interruptProviderThread, providerTurn, session };
      });

    // Whether an emitted terminal projects for the turn and its attempt.
    // Provider terminal events are projected on a detached ingestion fiber.
    // Yield through the Node event loop instead of sleeping on Effect's clock
    // so deterministic runtimes cannot deadlock a command waiting on it.
    const awaitProjectedTerminal = (input: {
      readonly threadId: ThreadId;
      readonly providerThreadId: ProviderThreadId;
      readonly providerTurnId: ProviderTurnId;
      readonly attemptId: RunAttemptId;
    }) =>
      Effect.gen(function* () {
        for (let remaining = 1_000; remaining > 0; remaining -= 1) {
          const { providerTurn, attempt } = yield* projections.getProviderControlContext(
            input.threadId,
            input,
          );
          if (
            providerTurn !== undefined &&
            providerTurn.status !== "running" &&
            attempt !== undefined &&
            attempt.status !== "running"
          ) {
            return true;
          }
          yield* yieldToRuntime;
        }
        return false;
      });

    /**
     * Ends a run as its ingestion would on an interrupted terminal, for a
     * stopped turn its adapter settled without the run seeing it end. Written
     * only while the run still runs that turn's attempt, so neither this nor
     * a late terminal can undo the other.
     */
    const endOrphanedRun = (input: {
      readonly threadId: ThreadId;
      readonly providerSessionId: ProviderSessionId;
      readonly providerTurn: OrchestrationV2ProviderTurn;
      readonly attemptId: RunAttemptId;
    }) =>
      Effect.gen(function* () {
        const records = yield* projections.getThreadRecords(
          input.threadId,
          ["runs", "attempts", "nodes", "providerThreads", "subagents", "turnItems"],
          { turnItemTypes: ["subagent"] },
        );
        const attempt = records.attempts.find((candidate) => candidate.id === input.attemptId);
        const run = records.runs.find((candidate) => candidate.id === attempt?.runId);
        const rootNode = records.nodes.find((candidate) => candidate.id === run?.rootNodeId);
        const providerThread = records.providerThreads.find(
          (candidate) => candidate.id === input.providerTurn.providerThreadId,
        );
        if (
          attempt === undefined ||
          run === undefined ||
          rootNode === undefined ||
          providerThread === undefined ||
          run.status !== "running" ||
          run.activeAttemptId !== attempt.id
        ) {
          return;
        }
        const openRunOwnedSubagents = RunExecutionService.openRunOwnedSubagentsFromProjection({
          run,
          subagents: records.subagents,
          turnItems: records.turnItems,
          nodes: records.nodes,
          childThreads: [],
        });
        const childThreads = yield* Effect.forEach(
          openRunOwnedSubagents.linkedChildThreadIds,
          (childThreadId) =>
            projections
              .getThreadRecords(childThreadId, ["nodes", "turnItems"], {
                turnItemStatuses: ["pending", "running", "waiting"],
              })
              .pipe(
                Effect.catchTags({
                  ProjectionStoreThreadNotFoundError: () =>
                    Effect.succeed({ nodes: [], turnItems: [] }),
                }),
              ),
        );
        const completedAt = yield* DateTime.now;
        // Normalized as ingestion would, which also cancels the turn's
        // unanswered native user input.
        const providerTurnEvents = yield* providerEventIngestor.normalize({
          providerSessionId: input.providerSessionId,
          providerInstanceId: run.providerInstanceId,
          threadId: input.threadId,
          runId: run.id,
          nodeId: rootNode.id,
          event: {
            type: "provider_turn.updated",
            driver: providerThread.driver,
            providerTurn: { ...input.providerTurn, status: "interrupted", completedAt },
          },
        });
        const finalization = yield* RunExecutionService.makeFinalRunWrite({
          idAllocator,
          run,
          rootNode,
          checkpointScopeId: rootNode.checkpointScopeId,
          providerThread,
          attempt,
          openRunOwnedSubagents: RunExecutionService.openRunOwnedSubagentsFromProjection({
            run,
            subagents: records.subagents,
            turnItems: records.turnItems,
            nodes: records.nodes,
            childThreads,
          }),
          terminal: {
            type: "turn.terminal",
            driver: providerThread.driver,
            providerThreadId: providerThread.id,
            providerTurnId: input.providerTurn.id,
            runOrdinal: run.ordinal,
            status: "interrupted",
            failure: null,
            threadDisposition: "reusable",
          },
          failureItemPersisted: false,
          completedAt,
        });
        yield* eventSink.writeIfRunCurrent({
          guardPendingUserInputCancellations: true,
          threadId: input.threadId,
          runId: run.id,
          activeAttemptId: attempt.id,
          expectedStatus: "running",
          events: [...providerTurnEvents, ...finalization.events],
          effects: finalization.effects,
        });
      });

    return ProviderTurnControlServiceV2.of({
      interrupt: (input) =>
        Effect.gen(function* () {
          const loaded = yield* load({ ...input, operation: "interrupt" });
          const session = Option.isSome(loaded.session)
            ? loaded.session
            : yield* sessions.get(input.providerSessionId);
          if (Option.isNone(session)) return;
          // A settled turn reaches its adapter too: only the adapter knows
          // whether it still runs work for the thread, and each one either
          // stops it or reports there is nothing left to stop. Background work
          // the projection still shows is settled by the orchestrator after.
          const outcome = yield* session.value.interruptTurn({
            providerThread: loaded.providerThread,
            providerTurnId: loaded.providerTurn.id,
            requestRuntimeRestart: true,
          });
          // A turn the adapter no longer holds may still look running: its
          // terminal can be on its way to the projection, or lost (#15197).
          const attemptId = loaded.providerTurn.runAttemptId;
          if (
            outcome !== "turn_not_active" ||
            loaded.providerTurn.status !== "running" ||
            attemptId === null
          ) {
            return;
          }
          const terminalized = yield* awaitProjectedTerminal({
            threadId: input.threadId,
            providerThreadId: input.providerThreadId,
            providerTurnId: loaded.providerTurn.id,
            attemptId,
          });
          if (!terminalized) {
            yield* endOrphanedRun({
              threadId: input.threadId,
              providerSessionId: input.providerSessionId,
              providerTurn: loaded.providerTurn,
              attemptId,
            });
          }
        }).pipe(
          Effect.mapError((cause) =>
            isProviderTurnControlError(cause)
              ? cause
              : new ProviderTurnControlError({
                  threadId: input.threadId,
                  operation: "interrupt",
                  providerTurnId: input.providerTurnId,
                  cause,
                }),
          ),
        ),
      interruptAndAwaitTerminal: (input) =>
        Effect.gen(function* () {
          const loaded = yield* load({ ...input, operation: "restart" });
          if (Option.isNone(loaded.session)) {
            // No live adapter: nothing can emit a terminal provider-turn update
            // from interrupt. Do not poll for projection terminalization or the
            // restart effect stalls; let detach/start proceed.
            if (loaded.providerTurn.status === "running") {
              yield* Effect.logWarning(
                "Provider restart interrupt skipped; no live session for a still-projected running turn",
                {
                  threadId: input.threadId,
                  providerSessionId: input.providerSessionId,
                  providerTurnId: input.providerTurnId,
                },
              );
            }
            return;
          }

          yield* loaded.session.value.interruptTurn({
            providerThread: loaded.providerThread,
            providerTurnId: loaded.providerTurn.id,
          });

          const terminalized = yield* awaitProjectedTerminal({
            threadId: input.threadId,
            providerThreadId: input.providerThreadId,
            providerTurnId: input.providerTurnId,
            attemptId: input.interruptedAttemptId,
          });
          if (terminalized) {
            return;
          }
          return yield* new ProviderTurnControlError({
            threadId: input.threadId,
            operation: "restart",
            providerTurnId: input.providerTurnId,
            cause: `Provider turn ${input.providerTurnId} did not terminalize before restart.`,
          });
        }).pipe(
          Effect.mapError((cause) =>
            isProviderTurnControlError(cause)
              ? cause
              : new ProviderTurnControlError({
                  threadId: input.threadId,
                  operation: "restart",
                  providerTurnId: input.providerTurnId,
                  cause,
                }),
          ),
        ),
      steer: (input) =>
        Effect.gen(function* () {
          const context = yield* projections.getProviderControlContext(input.threadId, input);
          const ownership = context.message?.delegatedCompletion;
          if (ownership !== undefined) {
            const projection = yield* projections.getThreadRecords(input.threadId, ["runs"], {
              runIds: [ownership.parentRunId],
            });
            const cohort = projection.runs.find(
              (run) => run.id === ownership.parentRunId,
            )?.delegatedCompletion;
            if (
              cohort?.disposition !== "open" ||
              cohort.delivery?.messageId !== input.messageId ||
              cohort.delivery.generation !== ownership.generation ||
              cohort.delivery.taskIds.length === 0
            )
              return;
          }
          const loaded = yield* load({ ...input, operation: "steer" });
          if (Option.isNone(loaded.session)) return;
          const { message, run } = loaded.context;
          if (message === undefined || run === undefined) {
            return yield* new ProviderTurnControlError({
              threadId: input.threadId,
              operation: "steer",
              providerTurnId: input.providerTurnId,
              cause: "The persisted steering message or target run is missing.",
            });
          }
          yield* loaded.session.value
            .steerTurn({
              threadId: input.threadId,
              runId: run.id,
              providerThread: loaded.providerThread,
              providerTurnId: loaded.providerTurn.id,
              message: {
                messageId: message.id,
                text: projectComposerContextForProvider({
                  text: message.text,
                  records: message.context?.records ?? [],
                }),
                attachments: message.attachments,
                createdBy: message.createdBy,
                creationSource: message.creationSource,
                ...(message.scheduledTaskId === undefined
                  ? {}
                  : { scheduledTaskId: message.scheduledTaskId }),
                ...(message.senderThreadId === undefined
                  ? {}
                  : { senderThreadId: message.senderThreadId }),
              },
            })
            .pipe(
              Effect.catch((cause) =>
                Effect.gen(function* () {
                  const current = yield* projections.getProviderControlContext(
                    input.threadId,
                    input,
                  );
                  return yield* new ProviderTurnControlError({
                    threadId: input.threadId,
                    operation: "steer",
                    providerTurnId: input.providerTurnId,
                    turnCompleted: current.providerTurn?.status === "completed",
                    cause,
                  });
                }),
              ),
            );
        }).pipe(
          Effect.mapError((cause) =>
            isProviderTurnControlError(cause)
              ? cause
              : new ProviderTurnControlError({
                  threadId: input.threadId,
                  operation: "steer",
                  providerTurnId: input.providerTurnId,
                  cause,
                }),
          ),
        ),
    });
  }),
);
