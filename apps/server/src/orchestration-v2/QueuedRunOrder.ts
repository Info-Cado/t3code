import type { OrchestrationV2Run, OrchestrationV2ThreadProjection } from "@t3tools/contracts";

export function isAutomaticCompletionRun(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "messages">,
  run: OrchestrationV2Run,
): boolean {
  return projection.messages.some(
    (message) => message.id === run.userMessageId && message.delegatedCompletion !== undefined,
  );
}

export function queuedRunsInDeliveryOrder(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "messages"> & {
    readonly thread?: Pick<OrchestrationV2ThreadProjection["thread"], "agentRole">;
  },
): ReadonlyArray<OrchestrationV2Run> {
  const automaticCompletionMessageIds = new Set(
    projection.messages
      .filter((message) => message.delegatedCompletion !== undefined)
      .map((message) => message.id),
  );
  // Agent reports can pile up behind a busy orchestrator; what the user types goes ahead of them.
  const userMessageIds = new Set(
    projection.thread?.agentRole === "orchestrator"
      ? projection.messages
          .filter(
            (message) =>
              message.createdBy === "user" &&
              (message.creationSource === "web" || message.creationSource === "mobile") &&
              message.scheduledTaskId === undefined,
          )
          .map((message) => message.id)
      : [],
  );
  const rank = (run: OrchestrationV2Run) =>
    userMessageIds.has(run.userMessageId)
      ? 2
      : automaticCompletionMessageIds.has(run.userMessageId)
        ? 1
        : 0;
  return projection.runs
    .filter((run) => run.status === "queued")
    .toSorted((left, right) => {
      const deliveryPriority = rank(right) - rank(left);
      return (
        deliveryPriority ||
        (left.queuePosition ?? left.ordinal) - (right.queuePosition ?? right.ordinal) ||
        left.ordinal - right.ordinal
      );
    });
}
