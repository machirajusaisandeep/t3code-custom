import {
  DESKTOP_LOCKED_USE_HEARTBEAT_MS,
  type DesktopBridge,
  type DesktopLockedUseState,
} from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useThreadShells } from "../state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { countLocalWorkingThreads, selectLocalEnvironmentIds } from "./useLockedUse.logic";

type LockedUseBridge = Pick<
  DesktopBridge,
  "getLockedUseState" | "setLockedUseEnabled" | "reportLocalAgentActivity"
>;

function getLockedUseBridge(): LockedUseBridge | undefined {
  if (typeof window === "undefined") return undefined;
  const bridge = window.desktopBridge;
  return typeof bridge?.getLockedUseState === "function" ? bridge : undefined;
}

/** How many local threads have an agent actively working right now. */
export function useLocalAgentActivityCount(): number {
  const threads = useThreadShells();
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();

  const localEnvironmentIds = useMemo(
    () => selectLocalEnvironmentIds({ primaryEnvironmentId, environments }),
    [environments, primaryEnvironmentId],
  );

  return useMemo(
    () => countLocalWorkingThreads(threads, localEnvironmentIds),
    [localEnvironmentIds, threads],
  );
}

export interface LockedUseSetting {
  /** False outside the desktop app, where there is no machine to keep awake. */
  readonly supported: boolean;
  readonly enabled: boolean;
  readonly setEnabled: (enabled: boolean) => void;
}

export function useLockedUseSetting(): LockedUseSetting {
  const bridge = getLockedUseBridge();
  const [state, setState] = useState<DesktopLockedUseState | null>(null);

  useEffect(() => {
    if (!bridge) return;
    let cancelled = false;
    void bridge
      .getLockedUseState()
      .then((next) => {
        if (!cancelled) setState(next);
      })
      .catch((cause: unknown) => {
        console.warn("Failed to read locked use state.", cause);
      });
    return () => {
      cancelled = true;
    };
  }, [bridge]);

  const setEnabled = useCallback(
    (enabled: boolean) => {
      if (!bridge) return;
      // Optimistic: the switch is a local preference write, and a failed write
      // is corrected by the state the main process echoes back.
      setState((current) => (current === null ? current : { ...current, enabled }));
      void bridge
        .setLockedUseEnabled(enabled)
        .then(setState)
        .catch((cause: unknown) => {
          console.warn("Failed to update locked use state.", cause);
          setState((current) => (current === null ? current : { ...current, enabled: !enabled }));
        });
    },
    [bridge],
  );

  return {
    supported: bridge !== undefined,
    enabled: state?.enabled ?? false,
    setEnabled,
  };
}

/**
 * Feeds the main process's locked-use lease.
 *
 * Reports on every change so a settling turn releases the machine promptly, and
 * re-reports on an interval while the count is non-zero so the main process can
 * treat a silent renderer as "gone" instead of "still busy". Mounted once, at
 * the app root — it renders nothing.
 */
export function useLockedUseActivityReporter(): void {
  const bridge = getLockedUseBridge();
  const activeThreadCount = useLocalAgentActivityCount();
  const lastReportedRef = useRef<number | null>(null);

  useEffect(() => {
    if (!bridge) return;

    const report = () => {
      lastReportedRef.current = activeThreadCount;
      void bridge.reportLocalAgentActivity(activeThreadCount).catch((cause: unknown) => {
        // A failed report only means the lease is not renewed, which fails
        // safe: the hold lapses rather than sticking.
        console.warn("Failed to report local agent activity.", cause);
      });
    };

    if (lastReportedRef.current !== activeThreadCount) {
      report();
    }
    if (activeThreadCount === 0) return;

    const heartbeat = setInterval(report, DESKTOP_LOCKED_USE_HEARTBEAT_MS);
    return () => {
      clearInterval(heartbeat);
    };
  }, [activeThreadCount, bridge]);
}
