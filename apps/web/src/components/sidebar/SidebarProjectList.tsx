import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { SquarePenIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { useQuietThreadShell } from "../../state/entities";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { useUiStateStore } from "../../uiStateStore";
import {
  resolveSidebarProjectStatus,
  resolveThreadLastVisitedAt,
  sortProjectsByAttention,
} from "../Sidebar.logic";
import { ProjectFavicon } from "../ProjectFavicon";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const STATUS = {
  attention: { label: "Needs you", className: "text-warning-foreground" },
  failed: { label: "Failed", className: "text-error-foreground" },
  unread: { label: "Done", className: "text-success-foreground" },
  working: { label: "Working", className: "text-info-foreground" },
} as const;

/** The sidebar in orchestrator mode: one row per project, saying only what it needs. */
export function SidebarProjectList(props: {
  groups: readonly SidebarProjectSnapshot[];
  /** Active threads: not archived, settled or snoozed. */
  threads: readonly EnvironmentThreadShell[];
  activeThread: ScopedThreadRef | null;
  onOpen: (group: SidebarProjectSnapshot) => void;
  onNewThread: (group: SidebarProjectSnapshot) => void;
  onContextMenu: (group: SidebarProjectSnapshot, position: { x: number; y: number }) => void;
}) {
  const localLastVisitedAtById = useUiStateStore((state) => state.threadLastVisitedAtById);
  const activeShell = useQuietThreadShell(props.activeThread);
  const threadsByProject = new Map<string, EnvironmentThreadShell[]>();
  for (const thread of props.threads) {
    const key = `${thread.environmentId}:${thread.projectId}`;
    threadsByProject.set(key, [...(threadsByProject.get(key) ?? []), thread]);
  }
  const statusByGroup = new Map(
    props.groups.map((group) => [
      group.projectKey,
      resolveSidebarProjectStatus(
        group.memberProjectRefs
          .flatMap((ref) => threadsByProject.get(`${ref.environmentId}:${ref.projectId}`) ?? [])
          .map((thread) => ({
            ...thread,
            lastVisitedAt: resolveThreadLastVisitedAt(
              thread.lastVisitedAt,
              localLastVisitedAtById[
                scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))
              ],
            ),
          })),
      ),
    ]),
  );
  const groups = sortProjectsByAttention(
    props.groups,
    (group) => statusByGroup.get(group.projectKey) ?? null,
  );
  return (
    <ul aria-label="Projects" className="flex flex-col gap-px">
      {groups.map((group) => {
        const state = statusByGroup.get(group.projectKey) ?? null;
        const status = state === null ? null : STATUS[state];
        const active =
          activeShell !== null &&
          group.memberProjectRefs.some(
            (ref) =>
              ref.environmentId === activeShell.environmentId &&
              ref.projectId === activeShell.projectId,
          );
        return (
          <li key={group.projectKey} className="group/project relative list-none">
            <button
              type="button"
              aria-current={active ? "true" : undefined}
              onClick={() => props.onOpen(group)}
              onContextMenu={(event) => {
                event.preventDefault();
                props.onContextMenu(group, { x: event.clientX, y: event.clientY });
              }}
              className={cn(
                "flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-(--control-radius) px-(--sidebar-row-content-inset) text-left outline-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring pointer-coarse:h-11",
                active && "bg-sidebar-row-selected",
              )}
            >
              <ProjectFavicon project={group} className="size-4 shrink-0" />
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-sm",
                  state === "attention" || state === "failed"
                    ? "font-semibold text-sidebar-foreground"
                    : state === null && !active
                      ? "font-normal text-sidebar-foreground/70"
                      : "font-medium text-sidebar-foreground/90",
                )}
              >
                {group.displayName}
              </span>
              {status ? (
                <span
                  className={cn(
                    "shrink-0 text-xs group-focus-within/project:invisible group-hover/project:invisible pointer-coarse:group-hover/project:visible",
                    status.className,
                  )}
                >
                  {status.label}
                </span>
              ) : null}
            </button>
            <span className="absolute inset-y-0 right-1 flex items-center opacity-0 focus-within:opacity-100 group-hover/project:opacity-100 pointer-coarse:hidden">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      size="icon-xs"
                      variant="ghost-muted"
                      aria-label={`New thread of your own in ${group.displayName}`}
                      onClick={() => props.onNewThread(group)}
                    />
                  }
                >
                  <SquarePenIcon aria-hidden />
                </TooltipTrigger>
                <TooltipPopup>New thread of your own</TooltipPopup>
              </Tooltip>
            </span>
          </li>
        );
      })}
    </ul>
  );
}
