import { describe, expect, it } from "vite-plus/test";

import { queuedRunsInDeliveryOrder } from "./QueuedRunOrder.ts";

describe("queued run delivery order", () => {
  it("keeps automatic completion delivery ahead of visible queued messages", () => {
    const projection = {
      messages: [
        { id: "message:visible-first" },
        {
          id: "message:automatic",
          delegatedCompletion: {
            generation: 1,
            parentRunId: "run:parent",
            taskIds: ["task:child"],
          },
        },
        { id: "message:visible-second" },
      ],
      runs: [
        {
          id: "run:visible-first",
          ordinal: 2,
          queuePosition: 1,
          status: "queued",
          userMessageId: "message:visible-first",
        },
        {
          id: "run:automatic",
          ordinal: 4,
          queuePosition: 3,
          status: "queued",
          userMessageId: "message:automatic",
        },
        {
          id: "run:visible-second",
          ordinal: 3,
          queuePosition: 2,
          status: "queued",
          userMessageId: "message:visible-second",
        },
      ],
    } as never;

    expect(queuedRunsInDeliveryOrder(projection).map((run) => run.id)).toEqual([
      "run:automatic",
      "run:visible-first",
      "run:visible-second",
    ]);
  });

  it("puts what the user types ahead of agent reports on an orchestrator only", () => {
    const projection = {
      messages: [
        {
          id: "message:report",
          createdBy: "agent",
          creationSource: "server",
          delegatedCompletion: {
            generation: 1,
            parentRunId: "run:parent",
            taskIds: ["task:child"],
          },
        },
        { id: "message:agent", createdBy: "agent", creationSource: "mcp" },
        { id: "message:phone", createdBy: "user", creationSource: "mobile" },
        { id: "message:web", createdBy: "user", creationSource: "web" },
      ],
      runs: [
        { id: "run:report", ordinal: 1, status: "queued", userMessageId: "message:report" },
        { id: "run:agent", ordinal: 2, status: "queued", userMessageId: "message:agent" },
        { id: "run:phone", ordinal: 3, status: "queued", userMessageId: "message:phone" },
        { id: "run:web", ordinal: 4, status: "queued", userMessageId: "message:web" },
      ],
    };

    expect(
      queuedRunsInDeliveryOrder({
        ...projection,
        thread: { agentRole: "orchestrator" },
      } as never).map((run) => run.id),
    ).toEqual(["run:phone", "run:web", "run:report", "run:agent"]);
    expect(
      queuedRunsInDeliveryOrder({ ...projection, thread: {} } as never).map((run) => run.id),
    ).toEqual(["run:report", "run:agent", "run:phone", "run:web"]);
  });
});
