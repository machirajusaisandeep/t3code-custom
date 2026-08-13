import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { openAppHrefInNewWindow, shouldOpenInNewWindow } from "./openAppWindow";

describe("shouldOpenInNewWindow", () => {
  it("is true for middle-click and modifier-click", () => {
    expect(shouldOpenInNewWindow({ button: 1, ctrlKey: false, metaKey: false })).toBe(true);
    expect(shouldOpenInNewWindow({ button: 0, ctrlKey: false, metaKey: true })).toBe(true);
    expect(shouldOpenInNewWindow({ button: 0, ctrlKey: true, metaKey: false })).toBe(true);
  });

  it("is false for a plain primary click", () => {
    expect(shouldOpenInNewWindow({ button: 0, ctrlKey: false, metaKey: false })).toBe(false);
  });
});

describe("openAppHrefInNewWindow", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("opens the href in a browsing context named _blank", () => {
    const open = vi.fn(() => null);
    vi.stubGlobal("window", { open });

    openAppHrefInNewWindow("/env/thread");

    expect(open).toHaveBeenCalledExactlyOnceWith("/env/thread", "_blank", "noopener,noreferrer");
  });
});
