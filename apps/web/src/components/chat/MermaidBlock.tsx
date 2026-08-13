import { CheckIcon, CodeIcon, CopyIcon, WrapTextIcon } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type ReactNode,
} from "react";

import { getClientSettings } from "../../hooks/useSettings";
import {
  mermaidFenceMarkdown,
  renderMermaidSvg,
  type MermaidTheme,
} from "../../lib/mermaidRendering";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

interface MermaidBlockProps {
  code: string;
  theme: MermaidTheme;
  isStreaming: boolean;
  fenceTitle?: string | null;
  children: ReactNode;
}

function reportMermaidActionFailure(operation: string, cause: unknown): void {
  console.error("[chat-markdown] mermaid action failed", { operation }, cause);
}

export function MermaidBlock({
  code,
  theme,
  isStreaming,
  fenceTitle,
  children,
}: MermaidBlockProps) {
  const [copied, setCopied] = useState(false);
  const [wrapped, setWrapped] = useState(() => getClientSettings().wordWrap);
  const [showSource, setShowSource] = useState(false);
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyLabel = copied ? "Copied" : "Copy diagram source";
  const wrapLabel = wrapped ? "Disable line wrap" : "Wrap lines";
  const sourceLabel = showSource ? "Show diagram" : "Show source";
  const showingDiagram = !showSource && svg != null;
  const clipboardMarkdown = mermaidFenceMarkdown(code);

  useEffect(() => {
    let cancelled = false;
    void renderMermaidSvg(code, theme).then((result) => {
      if (cancelled) return;
      if (result.ok) {
        setSvg(result.svg);
        setError(null);
        return;
      }
      setSvg(null);
      setError(isStreaming ? null : result.error);
    });
    return () => {
      cancelled = true;
    };
  }, [code, isStreaming, theme]);

  const handleCopy = useCallback(() => {
    if (typeof navigator === "undefined" || navigator.clipboard == null) {
      return;
    }
    void navigator.clipboard
      .writeText(code)
      .then(() => {
        if (copiedTimerRef.current != null) {
          clearTimeout(copiedTimerRef.current);
        }
        setCopied(true);
        copiedTimerRef.current = setTimeout(() => {
          setCopied(false);
          copiedTimerRef.current = null;
        }, 1200);
      })
      .catch((cause) => {
        reportMermaidActionFailure("copy-mermaid-source", cause);
      });
  }, [code]);

  const handleSelectionCopy = useCallback(
    (event: ReactClipboardEvent<HTMLDivElement>) => {
      if (!showingDiagram || !event.clipboardData) return;
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) return;
      const root = event.currentTarget;
      if (!root.contains(selection.anchorNode) || !root.contains(selection.focusNode)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      event.clipboardData.setData("text/plain", clipboardMarkdown.trimEnd());
    },
    [clipboardMarkdown, showingDiagram],
  );

  useEffect(
    () => () => {
      if (copiedTimerRef.current != null) {
        clearTimeout(copiedTimerRef.current);
        copiedTimerRef.current = null;
      }
    },
    [],
  );

  return (
    <div
      className="chat-markdown-codeblock border border-border/70 bg-secondary leading-snug dark:border-transparent dark:bg-input/32"
      data-language="mermaid"
      data-markdown-copy={clipboardMarkdown}
      data-mermaid={showingDiagram ? "diagram" : "source"}
      data-wrap={wrapped ? "true" : "false"}
      onCopy={handleSelectionCopy}
    >
      <div className="chat-markdown-codeblock-header select-none">
        <span className="chat-markdown-codeblock-title">
          <span className="truncate">{fenceTitle?.trim() || "mermaid"}</span>
        </span>
        <span
          className="flex items-center gap-0.5"
          role="toolbar"
          aria-label="Mermaid diagram actions"
        >
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="chat-markdown-chrome-action"
                  aria-pressed={showSource}
                  onClick={() => setShowSource((value) => !value)}
                  aria-label={sourceLabel}
                />
              }
            >
              <CodeIcon className="size-3" />
            </TooltipTrigger>
            <TooltipPopup side="top">{sourceLabel}</TooltipPopup>
          </Tooltip>
          {!showingDiagram ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="chat-markdown-chrome-action"
                    aria-pressed={wrapped}
                    onClick={() => setWrapped((value) => !value)}
                    aria-label={wrapLabel}
                  />
                }
              >
                <WrapTextIcon className="size-3" />
              </TooltipTrigger>
              <TooltipPopup side="top">{wrapLabel}</TooltipPopup>
            </Tooltip>
          ) : null}
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="chat-markdown-chrome-action"
                  onClick={handleCopy}
                  aria-label={copyLabel}
                />
              }
            >
              {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
            </TooltipTrigger>
            <TooltipPopup side="top">{copyLabel}</TooltipPopup>
          </Tooltip>
        </span>
      </div>
      {error && !showingDiagram ? (
        <div className="chat-markdown-mermaid-error" role="status">
          {error}
        </div>
      ) : null}
      {showingDiagram ? (
        <div className="chat-markdown-mermaid" dangerouslySetInnerHTML={{ __html: svg }} />
      ) : (
        children
      )}
    </div>
  );
}
