"use client";

import { useEffect, useRef, useState } from "react";
import type { TaskPendingToolCall } from "@open-harness/agent";
import { formatTokens, toRelativePath } from "@open-harness/shared";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ToolRendererProps } from "@/app/lib/render-tool";
import { DEFAULT_WORKING_DIRECTORY } from "@/lib/sandbox/config";
import { ToolLayout } from "../tool-layout";

function getToolSummary(toolCall: TaskPendingToolCall): string {
  const input = toolCall.input as Record<string, unknown> | undefined;
  switch (toolCall.name) {
    case "read":
    case "write":
    case "edit": {
      const fp = input?.filePath ?? "";
      return fp ? toRelativePath(String(fp), DEFAULT_WORKING_DIRECTORY) : "";
    }
    case "grep":
    case "glob":
      return input?.pattern ? `"${input.pattern}"` : "";
    case "bash":
      return input?.command ? String(input.command) : "";
    default:
      return "";
  }
}

function countToolCalls(messages: unknown): number {
  if (!Array.isArray(messages)) return 0;
  return messages.filter(
    (message) =>
      typeof message === "object" &&
      message !== null &&
      (message as { role?: string }).role === "tool",
  ).length;
}

function formatTime(seconds: number): string {
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}m ${secs}s`;
}

function useTaskTiming(isRunning: boolean, startedAtMs?: number) {
  const fallbackStartRef = useRef<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!isRunning) {
      return;
    }

    if (startedAtMs == null && !fallbackStartRef.current) {
      fallbackStartRef.current = Date.now();
    }

    setNow(Date.now());
    const interval = setInterval(() => {
      setNow(Date.now());
    }, 1000);

    return () => clearInterval(interval);
  }, [isRunning, startedAtMs]);

  const effectiveStart = startedAtMs ?? fallbackStartRef.current;
  if (!isRunning || effectiveStart == null) {
    return 0;
  }

  return Math.max(0, Math.floor((now - effectiveStart) / 1000));
}

function SubagentToolCall({
  toolCall,
  isRunning,
}: {
  toolCall: TaskPendingToolCall;
  isRunning: boolean;
}) {
  const summary = getToolSummary(toolCall);
  const displayName =
    toolCall.name.charAt(0).toUpperCase() + toolCall.name.slice(1);

  return (
    <div className="border-l-2 border-border py-1 pl-3">
      <div className="flex items-center gap-2">
        {isRunning ? (
          <Loader2 className="h-2.5 w-2.5 animate-spin text-yellow-500" />
        ) : (
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-green-500" />
        )}
        <span
          className={cn(
            "text-sm font-medium",
            isRunning ? "text-yellow-500" : "text-foreground",
          )}
        >
          {displayName}
        </span>
        {summary && (
          <>
            <span className="text-sm text-muted-foreground">(</span>
            <span className="text-sm text-foreground">{summary}</span>
            <span className="text-sm text-muted-foreground">)</span>
          </>
        )}
      </div>
      <pre className="ml-4 mt-1 max-h-32 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 font-mono text-xs text-foreground">
        {JSON.stringify(toolCall.input, null, 2)}
      </pre>
    </div>
  );
}

export function TaskRenderer({
  part,
  state,
  onApprove,
  onDeny,
}: ToolRendererProps<"tool-task">) {
  const input = part.input;
  const desc = input?.task ?? "Spawning subagent";
  const fullPrompt = input?.instructions;
  const subagentType = input?.subagentType;
  const taskApprovalRequested = part.state === "approval-requested";
  const taskDenied = part.state === "output-denied";

  const hasOutput = part.state === "output-available";
  const isPreliminary = hasOutput && part.preliminary === true;
  const isComplete = hasOutput && !isPreliminary;
  const output = hasOutput ? part.output : undefined;

  const pendingToolCall = output?.pending ?? null;
  const toolCount =
    output?.toolCallCount ?? (isComplete ? countToolCalls(output?.final) : 0);
  const tokenCount = output?.usage?.inputTokens ?? null;

  const isTaskStreaming = hasOutput && isPreliminary;
  const isRunningState =
    part.state === "input-streaming" ||
    part.state === "input-available" ||
    isTaskStreaming;
  const isActuallyRunning = isRunningState && !state.interrupted;

  const startedAt =
    typeof output?.startedAt === "number" ? output.startedAt : undefined;
  const elapsedSeconds = useTaskTiming(isActuallyRunning, startedAt);

  const subagentLabel =
    subagentType === "explorer"
      ? "Explorer"
      : subagentType === "executor"
        ? "Executor"
        : subagentType === "general"
          ? "General"
          : "Task";

  const indicator = state.interrupted ? (
    <span className="inline-block h-2 w-2 rounded-full border border-yellow-500" />
  ) : state.running || isActuallyRunning ? (
    <Loader2 className="h-3 w-3 animate-spin text-yellow-500" />
  ) : (
    <span
      className={cn(
        "inline-block h-2 w-2 rounded-full",
        taskDenied
          ? "bg-red-500"
          : taskApprovalRequested
            ? "bg-yellow-500"
            : isComplete
              ? "bg-green-500"
              : "bg-yellow-500",
      )}
    />
  );

  // Build accumulating meta for the right side
  const metaParts: string[] = [];

  if (toolCount > 0) {
    metaParts.push(`${toolCount} tool${toolCount === 1 ? "" : "s"}`);
  }

  if (isActuallyRunning) {
    if (elapsedSeconds > 0) {
      metaParts.push(formatTime(elapsedSeconds));
    }
  } else if (isComplete && tokenCount !== null) {
    metaParts.push(`${formatTokens(tokenCount)} tokens`);
  }

  const meta =
    metaParts.length > 0 ? (
      <span className="inline-flex items-center gap-1">
        {metaParts.join(" · ")}
      </span>
    ) : undefined;

  // Current activity status for expanded view
  let currentActivity: string | null = null;
  if (isActuallyRunning && pendingToolCall) {
    const displayName =
      pendingToolCall.name.charAt(0).toUpperCase() +
      pendingToolCall.name.slice(1);
    const summary = getToolSummary(pendingToolCall);
    currentActivity = summary ? `${displayName} ${summary}` : displayName;
  } else if (isActuallyRunning) {
    currentActivity = "Initializing...";
  } else if (state.interrupted) {
    currentActivity = "Interrupted";
  }

  const hasExpandableContent =
    pendingToolCall !== null ||
    Boolean(fullPrompt) ||
    isComplete ||
    currentActivity !== null;

  const expandedContent = hasExpandableContent ? (
    <div className="space-y-3">
      {/* Current activity when running */}
      {currentActivity && (
        <div>
          <div className="mb-1 text-xs font-medium text-muted-foreground">
            Current activity
          </div>
          <div className="text-sm text-foreground">{currentActivity}</div>
        </div>
      )}

      {/* Current tool call details when running */}
      {pendingToolCall && (
        <div>
          <div className="mb-1 text-xs font-medium text-muted-foreground">
            Current tool call
          </div>
          <SubagentToolCall
            toolCall={pendingToolCall}
            isRunning={isPreliminary}
          />
        </div>
      )}

      {/* Task prompt */}
      {fullPrompt && (
        <div>
          <div className="mb-1 text-xs font-medium text-muted-foreground">
            Task prompt
          </div>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 font-mono text-xs text-foreground">
            {fullPrompt}
          </pre>
        </div>
      )}

      {/* Subagent type */}
      {subagentType && (
        <div>
          <span className="text-xs text-muted-foreground">
            Subagent type:{" "}
          </span>
          <span className="text-sm text-foreground">{subagentType}</span>
        </div>
      )}

      {/* Completion stats */}
      {isComplete && (
        <div className="text-sm text-muted-foreground">
          Complete ({toolCount} tool call{toolCount === 1 ? "" : "s"}
          {tokenCount !== null
            ? `, ${formatTokens(tokenCount)} tokens`
            : ""}
          )
        </div>
      )}
    </div>
  ) : undefined;

  const approvalWarning =
    taskApprovalRequested && subagentType === "executor" ? (
      <div className="mt-2 pl-5 text-sm text-yellow-500">
        This executor has full write access and can create, modify, and delete
        files.
      </div>
    ) : undefined;

  return (
    <ToolLayout
      name={subagentLabel}
      summary={desc}
      meta={meta}
      state={state}
      indicator={indicator}
      nameClassName={taskDenied ? "text-red-500" : undefined}
      expandedContent={expandedContent}
      onApprove={onApprove}
      onDeny={onDeny}
    >
      {approvalWarning}
    </ToolLayout>
  );
}
