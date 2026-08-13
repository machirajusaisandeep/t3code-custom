import { LRUCache } from "./lruCache";

export const MAX_MERMAID_SOURCE_CHARS = 50_000;

const MAX_MERMAID_CACHE_ENTRIES = 100;
const MAX_MERMAID_CACHE_MEMORY_BYTES = 8 * 1024 * 1024;

const mermaidSvgCache = new LRUCache<string>(
  MAX_MERMAID_CACHE_ENTRIES,
  MAX_MERMAID_CACHE_MEMORY_BYTES,
);

export type MermaidTheme = "light" | "dark";

export type MermaidRenderResult =
  | { readonly ok: true; readonly svg: string }
  | { readonly ok: false; readonly error: string };

export interface MermaidApi {
  initialize: (config: Record<string, unknown>) => void;
  parse: (text: string, options?: { suppressErrors?: boolean }) => Promise<unknown>;
  render: (id: string, text: string) => Promise<{ svg: string }>;
}

type MermaidLoader = () => Promise<MermaidApi>;

let mermaidModulePromise: Promise<MermaidApi> | null = null;
let mermaidLoader: MermaidLoader = loadBundledMermaid;
let mermaidQueue: Promise<unknown> = Promise.resolve();
let renderSeq = 0;

async function loadBundledMermaid(): Promise<MermaidApi> {
  const module = await import("mermaid");
  return module.default;
}

function loadMermaid(): Promise<MermaidApi> {
  mermaidModulePromise ??= mermaidLoader();
  return mermaidModulePromise;
}

/** Test-only: swap the lazy mermaid import and drop cached diagrams. */
export function setMermaidLoaderForTests(loader: MermaidLoader | null): void {
  mermaidLoader = loader ?? loadBundledMermaid;
  mermaidModulePromise = null;
  mermaidQueue = Promise.resolve();
  mermaidSvgCache.clear();
}

export function isMermaidLanguage(language: string | undefined): boolean {
  if (!language) return false;
  const normalized = language.trim().toLowerCase();
  return normalized === "mermaid" || normalized === "mmd";
}

function mermaidFenceFor(code: string): string {
  const longestRun = [...(code.match(/`{3,}/g) ?? [])].reduce(
    (max, run) => Math.max(max, run.length),
    0,
  );
  return "`".repeat(Math.max(3, longestRun + 1));
}

export function mermaidFenceMarkdown(code: string): string {
  const body = code.replace(/\n$/, "");
  const fence = mermaidFenceFor(body);
  return `${fence}mermaid\n${body}\n${fence}\n\n`;
}

export function formatMermaidError(cause: unknown): string {
  const raw =
    cause instanceof Error
      ? cause.message
      : cause && typeof cause === "object" && "str" in cause && typeof cause.str === "string"
        ? cause.str
        : "";
  const firstLine =
    raw
      .split("\n")
      .find((line) => line.trim().length > 0)
      ?.trim() ?? "";
  if (!firstLine) return "Invalid mermaid diagram";
  return firstLine.length > 200 ? `${firstLine.slice(0, 197)}...` : firstLine;
}

function readSansFontFamily(): string {
  if (typeof document === "undefined") {
    return "ui-sans-serif, system-ui, sans-serif";
  }
  const value = getComputedStyle(document.documentElement).getPropertyValue("--font-sans").trim();
  return value || "ui-sans-serif, system-ui, sans-serif";
}

function mermaidConfig(theme: MermaidTheme): Record<string, unknown> {
  return {
    startOnLoad: false,
    securityLevel: "strict",
    htmlLabels: false,
    suppressErrorRendering: true,
    theme: theme === "dark" ? "dark" : "default",
    fontFamily: readSansFontFamily(),
    themeVariables: {
      background: "transparent",
    },
    flowchart: { useMaxWidth: true, htmlLabels: false },
    sequence: { useMaxWidth: true },
    gantt: { useMaxWidth: true },
    class: { useMaxWidth: true },
    state: { useMaxWidth: true },
    er: { useMaxWidth: true },
    pie: { useMaxWidth: true },
    journey: { useMaxWidth: true },
    gitGraph: { useMaxWidth: true },
  };
}

function mermaidCacheKey(source: string, theme: MermaidTheme): string {
  return `${theme}:${source.length}:${source}`;
}

function nextRenderId(): string {
  renderSeq += 1;
  return `t3mermaid-${renderSeq}`;
}

function enqueueMermaidRender<T>(task: () => Promise<T>): Promise<T> {
  const run = mermaidQueue.then(task, task);
  mermaidQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export async function renderMermaidSvg(
  source: string,
  theme: MermaidTheme,
): Promise<MermaidRenderResult> {
  const body = source.trim();
  if (!body) {
    return { ok: false, error: "Empty mermaid diagram" };
  }
  if (body.length > MAX_MERMAID_SOURCE_CHARS) {
    return { ok: false, error: "Diagram is too large to render" };
  }

  const cacheKey = mermaidCacheKey(body, theme);
  const cached = mermaidSvgCache.get(cacheKey);
  if (cached != null) {
    return { ok: true, svg: cached };
  }

  return enqueueMermaidRender(async () => {
    const queuedCache = mermaidSvgCache.get(cacheKey);
    if (queuedCache != null) {
      return { ok: true, svg: queuedCache };
    }

    try {
      const mermaid = await loadMermaid();
      mermaid.initialize(mermaidConfig(theme));
      const parsed = await mermaid.parse(body, { suppressErrors: true });
      if (!parsed) {
        return { ok: false, error: "Invalid mermaid diagram" };
      }

      const { svg } = await mermaid.render(nextRenderId(), body);
      if (!svg.trim()) {
        return { ok: false, error: "Mermaid produced an empty diagram" };
      }

      mermaidSvgCache.set(cacheKey, svg, Math.max(svg.length * 2, body.length));
      return { ok: true, svg };
    } catch (cause) {
      return { ok: false, error: formatMermaidError(cause) };
    }
  });
}
