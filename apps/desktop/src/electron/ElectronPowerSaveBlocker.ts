import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Electron from "electron";

/**
 * Thin wrapper over Electron's `powerSaveBlocker` so the locked-use policy can
 * be tested without a live Electron app.
 *
 * Only `prevent-app-suspension` is exposed. `prevent-display-sleep` would keep
 * the screen lit, which is the opposite of what "keep working while I'm away"
 * wants: the display should go dark and the machine should stay awake.
 */
export class ElectronPowerSaveBlocker extends Context.Service<
  ElectronPowerSaveBlocker,
  {
    readonly preventAppSuspension: Effect.Effect<number>;
    readonly stop: (id: number) => Effect.Effect<void>;
    readonly isStarted: (id: number) => Effect.Effect<boolean>;
  }
>()("@t3tools/desktop/electron/ElectronPowerSaveBlocker") {}

export const make = ElectronPowerSaveBlocker.of({
  preventAppSuspension: Effect.sync(() =>
    Electron.powerSaveBlocker.start("prevent-app-suspension"),
  ),
  // Electron throws on stopping an id it no longer knows about (it can be
  // reclaimed after a suspend/resume cycle), so the guard is load-bearing.
  stop: (id) =>
    Effect.sync(() => {
      if (Electron.powerSaveBlocker.isStarted(id)) {
        Electron.powerSaveBlocker.stop(id);
      }
    }),
  isStarted: (id) => Effect.sync(() => Electron.powerSaveBlocker.isStarted(id)),
});

export const layer = Layer.succeed(ElectronPowerSaveBlocker, make);
