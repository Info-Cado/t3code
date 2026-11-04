import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { DEFAULT_SERVER_SETTINGS, isListedThreadLineage, type ProjectId } from "@t3tools/contracts";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { resolveNewThreadModelSelection } from "@t3tools/shared/usageLimits";
import { useNavigate } from "@tanstack/react-router";

import { toastManager } from "../components/ui/toast";
import { newThreadId } from "../lib/utils";
import { resolveProjectDefaultProviderModelSelection } from "../providerInstances";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readProject, readThreadShells } from "../state/entities";
import { environmentServerConfigsAtom } from "../state/server";
import { threadEnvironment } from "../state/threads";
import { buildThreadRouteParams } from "../threadRoutes";
import { useAtomCommand } from "../state/use-atom-command";
import { useNewThreadHandler } from "./useHandleNewThread";

interface ProjectTarget {
  readonly environmentId: EnvironmentId;
  readonly id: ProjectId;
  /** A scratch folder holds separate tries, so nothing there runs as one project. */
  readonly isScratch?: boolean;
}

const liveOrchestrator = (project: ProjectTarget) =>
  readThreadShells().find(
    (thread) =>
      thread.agentRole === "orchestrator" &&
      thread.archivedAt === null &&
      thread.environmentId === project.environmentId &&
      thread.projectId === project.id,
  ) ?? null;

/** The action behind a project row: its orchestrator, made on first use. */
export function useOpenProjectOrchestrator() {
  const navigate = useNavigate();
  const createThread = useAtomCommand(threadEnvironment.create);
  const handleNewThread = useNewThreadHandler();
  const openThread = (project: ProjectTarget, threadId: ThreadId) =>
    navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(project.environmentId, threadId)),
    });

  return async (project: ProjectTarget): Promise<void> => {
    const projectRef = scopeProjectRef(project.environmentId, project.id);
    if (project.isScratch === true) {
      const latest = readThreadShells()
        .filter(
          (thread) =>
            thread.archivedAt === null &&
            thread.environmentId === project.environmentId &&
            thread.projectId === project.id &&
            isListedThreadLineage(thread.lineage),
        )
        .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
      if (latest === undefined) await handleNewThread(projectRef);
      else await openThread(project, latest.id);
      return;
    }
    const existing = liveOrchestrator(project);
    if (existing !== null) {
      await openThread(project, existing.id);
      return;
    }
    const config = appAtomRegistry.get(environmentServerConfigsAtom).get(project.environmentId);
    const settings = config?.settings ?? DEFAULT_SERVER_SETTINGS;
    const providers = config?.providers ?? [];
    const projectSettings = resolveProjectSettings(
      settings,
      project.id,
      readProject(projectRef),
    ).settings;
    const { selection } = resolveNewThreadModelSelection({
      defaultSelection:
        projectSettings.defaultModelSelection ??
        resolveProjectDefaultProviderModelSelection(providers, settings, project.id),
      fallbackSelection: settings.fallbackModelSelection ?? null,
      providers,
      settings,
      projectId: project.id,
      now: Date.now(),
    });
    if (selection === null) {
      // No usable provider yet: the draft's model picker says why and how to fix it.
      await handleNewThread(projectRef);
      return;
    }
    const threadId = newThreadId();
    const created = await createThread({
      environmentId: project.environmentId,
      input: {
        threadId,
        projectId: project.id,
        title: "Orchestrator",
        modelSelection: selection,
        runtimeMode: projectSettings.defaultRuntimeMode,
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        agentRole: "orchestrator",
      },
    });
    if (created._tag === "Failure") {
      // Another device may have made it first.
      const madeElsewhere = liveOrchestrator(project);
      if (madeElsewhere !== null) await openThread(project, madeElsewhere.id);
      else toastManager.add({ type: "error", title: "Could not open the orchestrator" });
      return;
    }
    await openThread(project, threadId);
  };
}
