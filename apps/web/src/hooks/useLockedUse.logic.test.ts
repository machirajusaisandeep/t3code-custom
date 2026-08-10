import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { desktopLocalConnectionId } from "../connection/desktopLocal";
import type { SidebarThreadSummary } from "../types";
import { countLocalWorkingThreads, selectLocalEnvironmentIds } from "./useLockedUse.logic";

const PRIMARY = EnvironmentId.make("environment-local");
const WSL = EnvironmentId.make("environment-wsl");
const REMOTE = EnvironmentId.make("environment-devbox");

let threadCounter = 0;

function makeThread(overrides: Partial<SidebarThreadSummary> = {}): SidebarThreadSummary {
  threadCounter += 1;
  return {
    environmentId: PRIMARY,
    id: ThreadId.make(`thread-${threadCounter}`),
    projectId: ProjectId.make("project-1"),
    title: `Thread ${threadCounter}`,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-10T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  } as SidebarThreadSummary;
}

function running(overrides: Partial<SidebarThreadSummary> = {}): SidebarThreadSummary {
  return makeThread({
    session: { status: "running" } as SidebarThreadSummary["session"],
    ...overrides,
  });
}

function bearerTarget(connectionId: string) {
  return { _tag: "BearerConnectionTarget", connectionId } as never;
}

describe("selectLocalEnvironmentIds", () => {
  it("counts the primary backend and desktop-local secondaries, not remotes", () => {
    const ids = selectLocalEnvironmentIds({
      primaryEnvironmentId: PRIMARY,
      environments: [
        { environmentId: WSL, entry: { target: bearerTarget(desktopLocalConnectionId("wsl")) } },
        { environmentId: REMOTE, entry: { target: bearerTarget("saved:devbox") } },
      ],
    });

    expect([...ids].sort()).toEqual([PRIMARY, WSL].sort());
  });

  it("is empty before a primary environment resolves", () => {
    expect(selectLocalEnvironmentIds({ primaryEnvironmentId: null, environments: [] }).size).toBe(
      0,
    );
  });
});

describe("countLocalWorkingThreads", () => {
  const local = new Set([PRIMARY, WSL]);

  it("counts only threads whose agent is mid-flight on a local backend", () => {
    const threads = [
      running(),
      running({ environmentId: WSL }),
      // Remote work does not need this machine awake.
      running({ environmentId: REMOTE }),
      // Blocked on the user, not on the machine staying awake.
      running({ hasPendingApprovals: true }),
      running({ hasPendingUserInput: true }),
      // Watch loops can run for hours; they must not pin a machine awake.
      makeThread({ backgroundLiveness: "monitoring" } as Partial<SidebarThreadSummary>),
      makeThread(),
    ];

    expect(countLocalWorkingThreads(threads, local)).toBe(2);
  });

  it("counts a settled turn whose background fleet is still running", () => {
    const threads = [
      makeThread({ backgroundLiveness: "working" } as Partial<SidebarThreadSummary>),
    ];

    expect(countLocalWorkingThreads(threads, local)).toBe(1);
  });

  it("ignores archived threads", () => {
    expect(countLocalWorkingThreads([running({ archivedAt: "2026-04-09T00:00:00.000Z" })], local)) //
      .toBe(0);
  });
});
