import { describe, expect, it } from "vite-plus/test";

import {
  composerFileMimeType,
  isHarAttachmentFile,
  isSupportedComposerFile,
} from "./composerAttachments";

describe("composer attachment files", () => {
  it("accepts HAR files even when the browser does not provide a MIME type", () => {
    const file = { name: "network-export.HAR", type: "" };

    expect(isHarAttachmentFile(file)).toBe(true);
    expect(isSupportedComposerFile(file)).toBe(true);
    expect(composerFileMimeType(file)).toBe("application/json");
  });

  it("continues accepting image files and rejecting unrelated files", () => {
    expect(isSupportedComposerFile({ name: "screen.png", type: "image/png" })).toBe(true);
    expect(isSupportedComposerFile({ name: "notes.json", type: "application/json" })).toBe(false);
  });
});
