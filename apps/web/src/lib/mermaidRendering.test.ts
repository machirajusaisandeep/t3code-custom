import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  formatMermaidError,
  isMermaidLanguage,
  mermaidFenceMarkdown,
  renderMermaidSvg,
  setMermaidLoaderForTests,
} from "./mermaidRendering";

afterEach(() => {
  setMermaidLoaderForTests(null);
});

describe("isMermaidLanguage", () => {
  it("accepts mermaid fence languages case-insensitively", () => {
    expect(isMermaidLanguage("mermaid")).toBe(true);
    expect(isMermaidLanguage("Mermaid")).toBe(true);
    expect(isMermaidLanguage(" mmd ")).toBe(true);
  });

  it("rejects other languages", () => {
    expect(isMermaidLanguage("ts")).toBe(false);
    expect(isMermaidLanguage("text")).toBe(false);
    expect(isMermaidLanguage(undefined)).toBe(false);
    expect(isMermaidLanguage("")).toBe(false);
  });
});

describe("mermaidFenceMarkdown", () => {
  it("wraps source in a mermaid fence", () => {
    expect(mermaidFenceMarkdown("flowchart TB\nA --> B")).toBe(
      "```mermaid\nflowchart TB\nA --> B\n```\n\n",
    );
  });

  it("lengthens the fence when the source contains backticks", () => {
    expect(mermaidFenceMarkdown("note: ```code```")).toBe(
      "````mermaid\nnote: ```code```\n````\n\n",
    );
  });
});

describe("formatMermaidError", () => {
  it("keeps the first line of a parse dump", () => {
    expect(formatMermaidError(new Error("Parse error on line 2:\nflowchart\n^"))).toBe(
      "Parse error on line 2:",
    );
  });

  it("falls back when the cause has no message", () => {
    expect(formatMermaidError(null)).toBe("Invalid mermaid diagram");
  });
});

describe("renderMermaidSvg", () => {
  it("rejects empty and oversized sources without loading mermaid", async () => {
    const load = vi.fn();
    setMermaidLoaderForTests(load);

    await expect(renderMermaidSvg("   \n", "dark")).resolves.toEqual({
      ok: false,
      error: "Empty mermaid diagram",
    });
    await expect(renderMermaidSvg("A".repeat(50_001), "light")).resolves.toEqual({
      ok: false,
      error: "Diagram is too large to render",
    });
    expect(load).not.toHaveBeenCalled();
  });

  it("renders valid diagrams and caches the svg", async () => {
    const render = vi.fn().mockResolvedValue({ svg: "<svg>ok</svg>" });
    const parse = vi.fn().mockResolvedValue({ diagramType: "flowchart-v2" });
    const initialize = vi.fn();
    setMermaidLoaderForTests(async () => ({ initialize, parse, render }));

    const first = await renderMermaidSvg("flowchart TB\nA --> B", "dark");
    const second = await renderMermaidSvg("flowchart TB\nA --> B", "dark");

    expect(first).toEqual({ ok: true, svg: "<svg>ok</svg>" });
    expect(second).toEqual({ ok: true, svg: "<svg>ok</svg>" });
    expect(parse).toHaveBeenCalledOnce();
    expect(render).toHaveBeenCalledOnce();
    expect(initialize).toHaveBeenCalledWith(
      expect.objectContaining({
        securityLevel: "strict",
        htmlLabels: false,
        theme: "dark",
      }),
    );
  });

  it("returns a parse error without calling render", async () => {
    const render = vi.fn();
    setMermaidLoaderForTests(async () => ({
      initialize: vi.fn(),
      parse: vi.fn().mockResolvedValue(false),
      render,
    }));

    await expect(renderMermaidSvg("not a diagram", "light")).resolves.toEqual({
      ok: false,
      error: "Invalid mermaid diagram",
    });
    expect(render).not.toHaveBeenCalled();
  });
});
