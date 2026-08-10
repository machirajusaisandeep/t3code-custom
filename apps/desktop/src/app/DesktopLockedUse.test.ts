import { DESKTOP_LOCKED_USE_HEARTBEAT_MS, DESKTOP_LOCKED_USE_LEASE_MS } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as ElectronPowerSaveBlocker from "../electron/ElectronPowerSaveBlocker.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopLockedUse from "./DesktopLockedUse.ts";

interface BlockerSpy {
  readonly layer: Layer.Layer<ElectronPowerSaveBlocker.ElectronPowerSaveBlocker>;
  readonly started: () => readonly number[];
  readonly stopped: () => readonly number[];
  readonly liveCount: () => number;
}

function makeBlockerSpy(): BlockerSpy {
  const started: number[] = [];
  const stopped: number[] = [];
  let nextId = 1;

  return {
    layer: Layer.succeed(
      ElectronPowerSaveBlocker.ElectronPowerSaveBlocker,
      ElectronPowerSaveBlocker.ElectronPowerSaveBlocker.of({
        preventAppSuspension: Effect.sync(() => {
          const id = nextId++;
          started.push(id);
          return id;
        }),
        stop: (id) =>
          Effect.sync(() => {
            stopped.push(id);
          }),
        isStarted: (id) => Effect.sync(() => started.includes(id) && !stopped.includes(id)),
      }),
    ),
    started: () => started,
    stopped: () => stopped,
    liveCount: () => started.length - stopped.length,
  };
}

function makeLayer(blocker: BlockerSpy, lockedUseEnabled: boolean) {
  return DesktopLockedUse.layer.pipe(
    Layer.provide(blocker.layer),
    Layer.provide(
      DesktopAppSettings.layerTest({
        ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
        lockedUseEnabled,
      }),
    ),
    Layer.provideMerge(TestClock.layer()),
  );
}

describe("DesktopLockedUse", () => {
  it.effect("holds the machine awake only while enabled and work is in flight", () => {
    const blocker = makeBlockerSpy();

    return Effect.gen(function* () {
      const lockedUse = yield* DesktopLockedUse.DesktopLockedUse;

      const idle = yield* lockedUse.getState;
      assert.isTrue(idle.enabled);
      assert.isFalse(idle.holding);
      assert.equal(blocker.liveCount(), 0);

      const working = yield* lockedUse.reportLocalAgentActivity(2);
      assert.isTrue(working.holding);
      assert.equal(working.activeThreadCount, 2);
      assert.equal(blocker.liveCount(), 1);

      // A further report while already holding must not stack assertions.
      yield* lockedUse.reportLocalAgentActivity(3);
      assert.equal(blocker.started().length, 1);

      const settled = yield* lockedUse.reportLocalAgentActivity(0);
      assert.isFalse(settled.holding);
      assert.equal(blocker.liveCount(), 0);
    }).pipe(Effect.provide(makeLayer(blocker, true)), Effect.scoped);
  });

  it.effect("never holds while the setting is off, and holds once it is turned on", () => {
    const blocker = makeBlockerSpy();

    return Effect.gen(function* () {
      const lockedUse = yield* DesktopLockedUse.DesktopLockedUse;

      const reported = yield* lockedUse.reportLocalAgentActivity(1);
      assert.isFalse(reported.enabled);
      assert.isFalse(reported.holding);
      assert.equal(blocker.liveCount(), 0);

      // Turning the toggle on mid-turn must pick up the activity already
      // reported rather than waiting for the next heartbeat.
      const enabled = yield* lockedUse.setEnabled(true);
      assert.isTrue(enabled.holding);
      assert.equal(blocker.liveCount(), 1);

      const disabled = yield* lockedUse.setEnabled(false);
      assert.isFalse(disabled.holding);
      assert.equal(blocker.liveCount(), 0);
    }).pipe(Effect.provide(makeLayer(blocker, false)), Effect.scoped);
  });

  it.effect("releases when the renderer stops renewing the lease", () => {
    const blocker = makeBlockerSpy();

    return Effect.gen(function* () {
      const lockedUse = yield* DesktopLockedUse.DesktopLockedUse;
      yield* lockedUse.reportLocalAgentActivity(1);
      assert.equal(blocker.liveCount(), 1);

      // A live renderer keeps renewing, so the hold survives the sweeper.
      yield* TestClock.adjust(Duration.millis(DESKTOP_LOCKED_USE_HEARTBEAT_MS));
      yield* lockedUse.reportLocalAgentActivity(1);
      assert.equal(blocker.liveCount(), 1);

      // A renderer that dies mid-turn stops renewing: the hold must lapse
      // rather than pin the machine awake forever.
      yield* TestClock.adjust(Duration.millis(DESKTOP_LOCKED_USE_LEASE_MS + 30_000));
      assert.equal(blocker.liveCount(), 0);
      assert.isFalse((yield* lockedUse.getState).holding);
    }).pipe(Effect.provide(makeLayer(blocker, true)), Effect.scoped);
  });

  it.effect("releases the assertion when the layer scope closes", () => {
    const blocker = makeBlockerSpy();

    return Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const lockedUse = yield* DesktopLockedUse.DesktopLockedUse;
        yield* lockedUse.reportLocalAgentActivity(1);
        assert.equal(blocker.liveCount(), 1);
      }).pipe(Effect.provide(makeLayer(blocker, true)), Effect.scoped);

      assert.equal(blocker.liveCount(), 0);
    });
  });
});
