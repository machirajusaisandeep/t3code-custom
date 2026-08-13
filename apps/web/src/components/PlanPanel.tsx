import type { ScopedThreadRef } from "@t3tools/contracts";
import { ListChecks } from "lucide-react";

import { proposedPlanTitle, stripDisplayedPlanMarkdown } from "~/proposedPlan";

import ChatMarkdown from "./ChatMarkdown";
import { ScrollArea } from "./ui/scroll-area";

export function PlanPanel(props: {
  planMarkdown: string | null;
  cwd: string | undefined;
  threadRef: ScopedThreadRef;
}) {
  const title = props.planMarkdown
    ? (proposedPlanTitle(props.planMarkdown) ?? "Proposed plan")
    : "Plan unavailable";

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="flex shrink-0 items-center gap-3 border-b border-border/70 px-5 py-4">
        <ListChecks aria-hidden className="size-5 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <h2 className="truncate text-sm font-medium text-foreground">{title}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">Proposed implementation plan</p>
        </div>
      </header>
      {props.planMarkdown ? (
        <ScrollArea className="min-h-0 flex-1">
          <div className="mx-auto w-full max-w-3xl px-5 py-6">
            <ChatMarkdown
              text={stripDisplayedPlanMarkdown(props.planMarkdown)}
              cwd={props.cwd}
              threadRef={props.threadRef}
              isStreaming={false}
            />
          </div>
        </ScrollArea>
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-center">
          <p className="max-w-64 text-sm text-muted-foreground">
            This plan is no longer available in the thread.
          </p>
        </div>
      )}
    </div>
  );
}
