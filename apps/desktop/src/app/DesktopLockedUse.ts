/**
 * DesktopLockedUse — "keep working while I'm away".
 *
 * Agents are child processes of the backend, so a locked screen never stops
 * them; idle sleep does, mid-turn. When the user opts in, this service holds a
 * `prevent-app-suspension` assertion for exactly as long as local agent work is
 * in flight, and drops it the moment everything settles. The toggle on its own
 * never keeps a machine awake — an idle T3 Code sleeps like any other app.
 *
 * Activity is reported by the renderer, which already derives "working" for the
 * sidebar and the board. That makes the renderer a liveness dependency, so the
 * report is a LEASE rather than a latch: each report extends the hold by
 * `DESKTOP_LOCKED_USE_LEASE_MS`, the renderer re-reports every
 * `DESKTOP_LOCKED_USE_HEARTBEAT_MS` while non-zero, and a sweeper releases once
 * the lease lapses. A renderer that crashes or is closed mid-turn can therefore
 * over-hold for one lease period, never indefinitely.
 *
 * @module DesktopLockedUse
 */
import type { DesktopLockedUseState } from "@t3tools/contracts";
import { DESKTOP_LOCKED_USE_LEASE_MS } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SynchronizedRef from "effect/SynchronizedRef";

import * as ElectronPowerSaveBlocker from "../electron/ElectronPowerSaveBlocker.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";

/**
 * How often the lease is re-checked. The renderer's heartbeat is what keeps a
 * hold alive; this only has to notice a lapsed lease reasonably promptly, so a
 * coarse tick keeps the idle cost at nothing.
 */
const LEASE_SWEEP_INTERVAL = Duration.seconds(30);

interface LockedUseHold {
  readonly activeThreadCount: number;
  readonly leaseExpiresAtMs: number;
  readonly blockerId: number | null;
}

const INITIAL_HOLD: LockedUseHold = {
  activeThreadCount: 0,
  leaseExpiresAtMs: 0,
  blockerId: null,
};

export class DesktopLockedUse extends Context.Service<
  DesktopLockedUse,
  {
    readonly getState: Effect.Effect<DesktopLockedUseState>;
    readonly setEnabled: (
      enabled: boolean,
    ) => Effect.Effect<DesktopLockedUseState, DesktopAppSettings.DesktopSettingsWriteError>;
    /** One renderer report; also serves as the heartbeat that renews the lease. */
    readonly reportLocalAgentActivity: (
      activeThreadCount: number,
    ) => Effect.Effect<DesktopLockedUseState>;
  }
>()("@t3tools/desktop/app/DesktopLockedUse") {}

export const make = Effect.fn("desktop.lockedUse.make")(function* () {
  const appSettings = yield* DesktopAppSettings.DesktopAppSettings;
  const powerSaveBlocker = yield* ElectronPowerSaveBlocker.ElectronPowerSaveBlocker;
  const hold = yield* SynchronizedRef.make(INITIAL_HOLD);

  /**
   * Start or stop the assertion so it matches the current inputs. Runs inside
   * `updateEffect` so the Electron start/stop pair can never interleave with a
   * concurrent report and strand a blocker id.
   */
  const reconcile = SynchronizedRef.updateEffect(hold, (current) =>
    Effect.gen(function* () {
      const settings = yield* appSettings.get;
      const nowMs = yield* Clock.currentTimeMillis;
      const shouldHold =
        settings.lockedUseEnabled &&
        current.activeThreadCount > 0 &&
        nowMs < current.leaseExpiresAtMs;

      if (shouldHold && current.blockerId === null) {
        const blockerId = yield* powerSaveBlocker.preventAppSuspension;
        yield* Effect.logInfo("Locked use is holding the machine awake.").pipe(
          Effect.annotateLogs({ activeThreadCount: current.activeThreadCount, blockerId }),
        );
        return { ...current, blockerId };
      }
      if (!shouldHold && current.blockerId !== null) {
        yield* powerSaveBlocker.stop(current.blockerId);
        yield* Effect.logInfo("Locked use released the machine.").pipe(
          Effect.annotateLogs({ blockerId: current.blockerId }),
        );
        return { ...current, blockerId: null };
      }
      return current;
    }),
  );

  const getState: Effect.Effect<DesktopLockedUseState> = Effect.gen(function* () {
    const settings = yield* appSettings.get;
    const current = yield* SynchronizedRef.get(hold);
    return {
      enabled: settings.lockedUseEnabled,
      holding: current.blockerId !== null,
      activeThreadCount: current.activeThreadCount,
    };
  });

  // A lapsed lease is only observable on a tick: with the renderer gone there
  // is no report left to trigger a reconcile.
  yield* reconcile.pipe(Effect.delay(LEASE_SWEEP_INTERVAL), Effect.forever, Effect.forkScoped);

  // Quitting must not leave an assertion behind for the OS to reclaim on its
  // own schedule.
  yield* Effect.addFinalizer(() =>
    SynchronizedRef.updateEffect(hold, (current) =>
      current.blockerId === null
        ? Effect.succeed(current)
        : powerSaveBlocker.stop(current.blockerId).pipe(Effect.as({ ...current, blockerId: null })),
    ).pipe(Effect.ignore),
  );

  return DesktopLockedUse.of({
    getState,

    setEnabled: (enabled) =>
      appSettings
        .setLockedUseEnabled(enabled)
        .pipe(
          Effect.andThen(reconcile),
          Effect.andThen(getState),
          Effect.withSpan("desktop.lockedUse.setEnabled", { attributes: { enabled } }),
        ),

    reportLocalAgentActivity: (activeThreadCount) =>
      Effect.gen(function* () {
        const nowMs = yield* Clock.currentTimeMillis;
        // A zero report is an immediate release, not a lapsing lease: the
        // renderer is telling us the work is done right now.
        const leaseExpiresAtMs = activeThreadCount > 0 ? nowMs + DESKTOP_LOCKED_USE_LEASE_MS : 0;
        yield* SynchronizedRef.update(hold, (current) => ({
          ...current,
          activeThreadCount: Math.max(0, Math.trunc(activeThreadCount)),
          leaseExpiresAtMs,
        }));
        yield* reconcile;
        return yield* getState;
      }).pipe(
        Effect.withSpan("desktop.lockedUse.reportLocalAgentActivity", {
          attributes: { activeThreadCount },
        }),
      ),
  });
});

export const layer = Layer.effect(DesktopLockedUse, make());
