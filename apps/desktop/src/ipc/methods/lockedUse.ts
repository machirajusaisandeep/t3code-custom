import { DesktopLockedUseStateSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopLockedUse from "../../app/DesktopLockedUse.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

const ActiveThreadCount = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0));

export const getLockedUseState = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GET_LOCKED_USE_STATE_CHANNEL,
  payload: Schema.Void,
  result: DesktopLockedUseStateSchema,
  handler: Effect.fn("desktop.ipc.lockedUse.getState")(function* () {
    const lockedUse = yield* DesktopLockedUse.DesktopLockedUse;
    return yield* lockedUse.getState;
  }),
});

export const setLockedUseEnabled = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SET_LOCKED_USE_ENABLED_CHANNEL,
  payload: Schema.Boolean,
  result: DesktopLockedUseStateSchema,
  handler: Effect.fn("desktop.ipc.lockedUse.setEnabled")(function* (enabled) {
    const lockedUse = yield* DesktopLockedUse.DesktopLockedUse;
    return yield* lockedUse.setEnabled(enabled);
  }),
});

export const reportLocalAgentActivity = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.REPORT_LOCAL_AGENT_ACTIVITY_CHANNEL,
  payload: ActiveThreadCount,
  result: DesktopLockedUseStateSchema,
  handler: Effect.fn("desktop.ipc.lockedUse.reportLocalAgentActivity")(
    function* (activeThreadCount) {
      const lockedUse = yield* DesktopLockedUse.DesktopLockedUse;
      return yield* lockedUse.reportLocalAgentActivity(activeThreadCount);
    },
  ),
});
