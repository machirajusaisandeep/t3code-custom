import type { ConnectionTarget } from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";

import { resolveSidebarV2Status } from "../components/Sidebar.logic";
import { isDesktopLocalConnectionTarget } from "../connection/desktopLocal";
import type { SidebarThreadSummary } from "../types";

interface LocalEnvironmentCandidate {
  readonly environmentId: EnvironmentId;
  readonly entry: { readonly target: ConnectionTarget };
}

/**
 * Locked use keeps the HOST machine awake, so only host-managed backends count.
 * An SSH or relay environment does its work on the far end: its turns survive
 * this machine sleeping, and holding the laptop awake for them would be a
 * battery cost with nothing to show for it.
 */
export function selectLocalEnvironmentIds(input: {
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly environments: ReadonlyArray<LocalEnvironmentCandidate>;
}): ReadonlySet<EnvironmentId> {
  const ids = new Set<EnvironmentId>();
  if (input.primaryEnvironmentId !== null) {
    ids.add(input.primaryEnvironmentId);
  }
  for (const environment of input.environments) {
    if (isDesktopLocalConnectionTarget(environment.entry.target)) {
      ids.add(environment.environmentId);
    }
  }
  return ids;
}

/**
 * Deliberately narrower than "not idle": a thread waiting on an approval or on
 * your input is blocked on YOU, and "monitoring" watch loops (PR babysitting,
 * log tails) can run for hours. Neither should hold a machine awake — only work
 * that is genuinely mid-flight and would be cut short by sleep.
 */
export function countLocalWorkingThreads(
  threads: ReadonlyArray<SidebarThreadSummary>,
  localEnvironmentIds: ReadonlySet<EnvironmentId>,
): number {
  return threads.filter(
    (thread) =>
      thread.archivedAt === null &&
      localEnvironmentIds.has(thread.environmentId) &&
      resolveSidebarV2Status(thread) === "working",
  ).length;
}
