import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  isListedThreadLineage,
  orchestratorCannotEdit,
  type EnvironmentId,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { NetworkIcon, PlusIcon, SquareIcon, SquarePenIcon } from "lucide-react";
import * as Schema from "effect/Schema";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { useOpenProjectOrchestrator } from "../../hooks/useOpenProjectOrchestrator";
import { useClientSettings } from "../../hooks/useSettings";
import { useQuietThreadShells } from "../../state/entities";
import { useEnvironmentProviders } from "../../state/environments";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { RightPanelSheet } from "../RightPanelSheet";
import { resolveSidebarThreadStatus } from "../Sidebar.logic";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { ThreadRelationshipsPanel } from "./ThreadRelationshipsControl";

const INLINE_OPEN_KEY = "t3code:project-agents-panel-open";

const STATUS_CLASS = {
  approval: "bg-warning",
  input: "bg-warning",
  request: "bg-warning",
  limited: "bg-warning",
  failed: "bg-error",
  working: "bg-info",
} as const;

/** The panel beside the chat, or a sheet where the window has no room for it. */
export function useProjectAgentsPanel(input: {
  readonly embedded: boolean;
  readonly sheet: boolean;
}) {
  const enabled = useClientSettings((settings) => settings.orchestratorModeEnabled);
  const [inlineOpen, setInlineOpen] = useLocalStorage(INLINE_OPEN_KEY, true, Schema.Boolean);
  const [sheetOpen, setSheetOpen] = useState(false);
  return {
    available: enabled && !input.embedded,
    sheet: input.sheet,
    open: input.sheet ? sheetOpen : inlineOpen,
    toggle: () => (input.sheet ? setSheetOpen((open) => !open) : setInlineOpen((open) => !open)),
    closeSheet: () => setSheetOpen(false),
  };
}

export function ProjectAgentsPanelHost(props: {
  readonly state: ReturnType<typeof useProjectAgentsPanel>;
  readonly project: { readonly environmentId: EnvironmentId; readonly id: ProjectId };
  readonly activeThreadId: ThreadId | null;
  readonly rightPanelOpen: boolean;
}) {
  const crowded = useMediaQuery("(max-width: 1279px)");
  if (props.state.sheet) {
    return (
      <RightPanelSheet
        animationDurationMs={0}
        open={props.state.open}
        onClose={props.state.closeSheet}
      >
        <div className="flex h-full min-h-0 flex-col pt-(--workspace-topbar-height)">
          <ProjectAgents
            project={props.project}
            activeThreadId={props.activeThreadId}
            onNavigate={props.state.closeSheet}
          />
        </div>
      </RightPanelSheet>
    );
  }
  if (!props.state.open || (props.rightPanelOpen && crowded)) return null;
  return (
    <aside
      aria-label="Agents"
      className="flex h-full w-72 shrink-0 flex-col border-s border-border bg-background pt-(--workspace-topbar-height)"
    >
      <ProjectAgents project={props.project} activeThreadId={props.activeThreadId} />
    </aside>
  );
}

function ProjectAgents(props: {
  readonly project: { readonly environmentId: EnvironmentId; readonly id: ProjectId };
  readonly activeThreadId: ThreadId | null;
  readonly onNavigate?: () => void;
}) {
  const { environmentId, id: projectId } = props.project;
  const shells = useQuietThreadShells().filter(
    (thread) =>
      thread.environmentId === environmentId &&
      thread.projectId === projectId &&
      thread.archivedAt === null,
  );
  const orchestrator = shells.find((thread) => thread.agentRole === "orchestrator") ?? null;
  const yours = shells.filter(
    (thread) =>
      thread.agentRole === undefined &&
      isListedThreadLineage(thread.lineage) &&
      // A thread the user is in stays listed, so settling it does not move them out of the list.
      (thread.id === props.activeThreadId || thread.settledOverride !== "settled"),
  );
  const agentsWork =
    orchestrator !== null &&
    shells.some(
      (thread) =>
        thread.lineage.relationshipToParent === "subagent" &&
        thread.lineage.parentThreadId === orchestrator.id &&
        !["ready", "failed", "limited"].includes(resolveSidebarThreadStatus(thread)),
    );
  const providers = useEnvironmentProviders().get(environmentId);
  const driver = providers?.find(
    (provider) => provider.instanceId === orchestrator?.providerInstanceId,
  )?.driver;
  const navigate = useNavigate();
  const handleNewThread = useNewThreadHandler();
  const openOrchestrator = useOpenProjectOrchestrator();
  const interruptTurn = useAtomCommand(threadEnvironment.interruptTurn);

  const openThread = (threadId: ThreadId) => {
    props.onNavigate?.();
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(environmentId, threadId)),
    });
  };
  const stopAll = async () => {
    if (orchestrator === null) return;
    const result = await interruptTurn({
      environmentId,
      input: { threadId: orchestrator.id, stopAgents: true },
    });
    if (result._tag === "Failure") {
      toastManager.add({ type: "error", title: "Could not stop the agents" });
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-2">
      <div className="flex flex-col gap-1">
        <div className={cn("rounded-lg", orchestrator?.id === props.activeThreadId && "bg-accent")}>
          <ThreadDetailsControl
            size="sm"
            variant="ghost"
            part="row"
            aria-current={orchestrator?.id === props.activeThreadId ? "true" : undefined}
            onClick={() => {
              props.onNavigate?.();
              void openOrchestrator(props.project);
            }}
          >
            <NetworkIcon aria-hidden className="size-3.5 shrink-0 text-info-foreground" />
            <span className="min-w-0 flex-1 truncate text-left text-sm font-medium">
              Orchestrator
            </span>
            {orchestrator ? <StatusDot thread={orchestrator} /> : null}
          </ThreadDetailsControl>
        </div>
        {driver !== undefined && !orchestratorCannotEdit(driver) ? (
          <p className="px-2 text-2xs text-warning-foreground">
            This provider can still edit files.
          </p>
        ) : null}
      </div>
      {orchestrator ? (
        <ThreadRelationshipsPanel
          environmentId={environmentId}
          threadId={orchestrator.id}
          showLineage
          showSideChats={false}
          agentsPanel={{
            activeThreadId: props.activeThreadId,
            ...(props.onNavigate === undefined ? {} : { onOpenThread: props.onNavigate }),
            actions: agentsWork ? (
              <button
                type="button"
                onClick={() => void stopAll()}
                className="flex h-6 cursor-pointer items-center gap-1 rounded-md px-1.5 text-2xs text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
              >
                <SquareIcon aria-hidden className="size-2.5 fill-current" />
                Stop all
              </button>
            ) : null,
          }}
        />
      ) : null}
      <ThreadDetailsSection
        headingId="project-agents-yours-heading"
        title="Yours"
        showHeading
        actions={
          <Tooltip>
            <TooltipTrigger
              render={
                <ThreadDetailsControl
                  size="icon-xs"
                  variant="ghost"
                  part="icon"
                  aria-label="New thread of your own"
                  onClick={() => {
                    props.onNavigate?.();
                    void handleNewThread(scopeProjectRef(environmentId, projectId));
                  }}
                />
              }
            >
              <PlusIcon aria-hidden className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="left">New thread of your own</TooltipPopup>
          </Tooltip>
        }
      >
        <ul className="flex flex-col">
          {yours.map((thread) => (
            <li
              key={thread.id}
              className={cn(
                "flex h-8 items-center rounded-lg",
                thread.id === props.activeThreadId && "bg-accent",
              )}
            >
              <ThreadDetailsControl
                size="sm"
                variant="ghost"
                part="row"
                aria-current={thread.id === props.activeThreadId ? "true" : undefined}
                onClick={() => openThread(thread.id)}
              >
                <SquarePenIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-left text-sm font-medium leading-4 text-foreground/85">
                  {thread.title}
                </span>
                <StatusDot thread={thread} />
              </ThreadDetailsControl>
            </li>
          ))}
        </ul>
      </ThreadDetailsSection>
    </div>
  );
}

function StatusDot(props: { readonly thread: EnvironmentThreadShell }) {
  const status = resolveSidebarThreadStatus(props.thread);
  if (status === "ready" || status === "waiting") return null;
  return (
    <span
      aria-label={status}
      className={cn("size-1.5 shrink-0 rounded-full", STATUS_CLASS[status])}
    />
  );
}
