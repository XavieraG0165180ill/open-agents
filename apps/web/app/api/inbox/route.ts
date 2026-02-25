import { createHash } from "node:crypto";
import { gateway, generateText, type GatewayModelId } from "ai";
import { getSessionInboxContexts } from "@/lib/db/inbox";
import type {
  GetInboxResponse,
  InboxEventType,
  InboxGroup,
  InboxItem,
  InboxSeverity,
} from "@/lib/inbox/types";
import { getServerSession } from "@/lib/session/get-server-session";

interface ToolSignals {
  hasPendingQuestion: boolean;
  hasPendingApproval: boolean;
  hasToolError: boolean;
}

interface ContextSummary {
  summary: string;
  request: string | null;
  outcome: string | null;
  generatedByModel: boolean;
}

interface SummaryCacheEntry {
  summary: string;
  request: string | null;
  outcome: string | null;
  createdAt: number;
}

const QUICK_SUMMARY_MODEL_ID = "google/gemini-2.5-flash";
const MAX_MODEL_SUMMARIES_PER_REQUEST = 8;
const SUMMARY_CACHE_TTL_MS = 5 * 60 * 1000;
const summaryCache = new Map<string, SummaryCacheEntry>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toLowerText(value: string | null | undefined): string {
  return (value ?? "").toLowerCase();
}

function truncateText(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }

  return `${text.slice(0, limit - 1).trimEnd()}…`;
}

function normalizeMessageText(text: string | null | undefined): string | null {
  if (!text) {
    return null;
  }

  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : null;
}

function getSummaryCacheKey(
  request: string | null,
  outcome: string | null,
): string {
  return createHash("sha256")
    .update(request ?? "")
    .update("\n")
    .update(outcome ?? "")
    .digest("hex");
}

function pruneSummaryCache(now: number): void {
  for (const [cacheKey, cacheEntry] of summaryCache.entries()) {
    if (cacheEntry.createdAt + SUMMARY_CACHE_TTL_MS <= now) {
      summaryCache.delete(cacheKey);
    }
  }
}

function fallbackSummary(
  request: string | null,
  outcome: string | null,
  eventType: InboxEventType,
): string {
  const shortRequest = request ? truncateText(request, 120) : null;
  const shortOutcome = outcome ? truncateText(outcome, 160) : null;

  if (shortRequest && shortOutcome) {
    return `${shortRequest} → ${shortOutcome}`;
  }

  if (shortRequest) {
    return shortRequest;
  }

  if (shortOutcome) {
    return shortOutcome;
  }

  switch (eventType) {
    case "question_asked":
      return "Agent asked for more input before it can continue.";
    case "approval_requested":
      return "Agent is blocked on a pending approval request.";
    case "run_failed":
      return "Run failed and needs your intervention.";
    case "review_ready":
      return "Run completed and is ready for your review.";
    case "run_completed_no_output":
      return "Run ended without meaningful code changes.";
    case "running_update":
      return "Run is still in progress.";
  }
}

async function summarizeContext(args: {
  request: string | null;
  outcome: string | null;
  eventType: InboxEventType;
  allowModelSummary: boolean;
}): Promise<ContextSummary> {
  const request = normalizeMessageText(args.request);
  const outcome = normalizeMessageText(args.outcome);

  if (!args.allowModelSummary || (!request && !outcome)) {
    return {
      summary: fallbackSummary(request, outcome, args.eventType),
      request,
      outcome,
      generatedByModel: false,
    };
  }

  const now = Date.now();
  pruneSummaryCache(now);

  const cacheKey = getSummaryCacheKey(request, outcome);
  const cached = summaryCache.get(cacheKey);

  if (cached && cached.createdAt + SUMMARY_CACHE_TTL_MS > now) {
    return {
      summary: cached.summary,
      request: cached.request,
      outcome: cached.outcome,
      generatedByModel: true,
    };
  }

  try {
    const summaryPrompt = [
      "You are writing a compact inbox preview for an engineering task.",
      "Summarize in one sentence under 24 words.",
      "Focus on: what the user asked and what the assistant most recently produced.",
      "No markdown, no labels, no quotes.",
      `User request: ${request ?? "(none)"}`,
      `Latest assistant output: ${outcome ?? "(none)"}`,
    ].join("\n");

    const response = await generateText({
      model: gateway(QUICK_SUMMARY_MODEL_ID as GatewayModelId),
      prompt: summaryPrompt,
      maxOutputTokens: 90,
      temperature: 0,
    });

    const summary = truncateText(
      response.text.trim().replace(/\s+/g, " "),
      180,
    );

    if (summary.length > 0) {
      summaryCache.set(cacheKey, {
        summary,
        request,
        outcome,
        createdAt: now,
      });

      return {
        summary,
        request,
        outcome,
        generatedByModel: true,
      };
    }
  } catch (error) {
    console.warn("Failed to generate inbox summary via quick model:", error);
  }

  return {
    summary: fallbackSummary(request, outcome, args.eventType),
    request,
    outcome,
    generatedByModel: false,
  };
}

function getToolSignals(parts: unknown[] | null): ToolSignals {
  if (!parts) {
    return {
      hasPendingQuestion: false,
      hasPendingApproval: false,
      hasToolError: false,
    };
  }

  let hasPendingQuestion = false;
  let hasPendingApproval = false;
  let hasToolError = false;

  for (const part of parts) {
    if (!isRecord(part)) continue;

    const type = part.type;
    const state = part.state;

    if (typeof type !== "string" || typeof state !== "string") {
      continue;
    }

    if (type === "tool-ask_user_question" && state === "input-available") {
      hasPendingQuestion = true;
    }

    if (type.startsWith("tool-") && state === "approval-requested") {
      hasPendingApproval = true;
    }

    if (type.startsWith("tool-") && state === "output-error") {
      hasToolError = true;
    }
  }

  return {
    hasPendingQuestion,
    hasPendingApproval,
    hasToolError,
  };
}

function getEventGroup(eventType: InboxEventType): InboxGroup {
  switch (eventType) {
    case "question_asked":
    case "approval_requested":
    case "run_failed":
      return "action_required";
    case "review_ready":
      return "review_ready";
    case "run_completed_no_output":
      return "no_output";
    case "running_update":
      return "updates";
  }
}

function getEventSeverity(eventType: InboxEventType): InboxSeverity {
  switch (eventType) {
    case "question_asked":
    case "approval_requested":
      return "critical";
    case "run_failed":
      return "high";
    case "run_completed_no_output":
      return "medium";
    case "review_ready":
      return "medium";
    case "running_update":
      return "low";
  }
}

function deriveEventType(args: {
  hasPendingQuestion: boolean;
  hasPendingApproval: boolean;
  hasFailure: boolean;
  hasUnread: boolean;
  hasStreaming: boolean;
  hasMeaningfulOutput: boolean;
}): InboxEventType | null {
  if (args.hasPendingQuestion) return "question_asked";
  if (args.hasPendingApproval) return "approval_requested";
  if (args.hasFailure) return "run_failed";

  const completedWithUnread = args.hasUnread && !args.hasStreaming;

  if (completedWithUnread && !args.hasMeaningfulOutput) {
    return "run_completed_no_output";
  }

  if (completedWithUnread && args.hasMeaningfulOutput) {
    return "review_ready";
  }

  if (args.hasStreaming) {
    return "running_update";
  }

  return null;
}

function getEventCopy(eventType: InboxEventType): {
  title: string;
  primaryActionLabel: string;
} {
  switch (eventType) {
    case "question_asked":
      return {
        title: "Question from agent",
        primaryActionLabel: "Answer",
      };
    case "approval_requested":
      return {
        title: "Approval required",
        primaryActionLabel: "Review",
      };
    case "run_failed":
      return {
        title: "Run blocked",
        primaryActionLabel: "Investigate",
      };
    case "review_ready":
      return {
        title: "Review ready",
        primaryActionLabel: "Quick review",
      };
    case "run_completed_no_output":
      return {
        title: "Run completed with no output",
        primaryActionLabel: "Quick review",
      };
    case "running_update":
      return {
        title: "Run in progress",
        primaryActionLabel: "Open",
      };
  }
}

function includesQuery(args: {
  query: string;
  title: string;
  repoOwner: string | null;
  repoName: string | null;
  branch: string | null;
  request: string | null;
  outcome: string | null;
}): boolean {
  if (!args.query) return true;

  const haystack = [
    args.title,
    args.repoOwner,
    args.repoName,
    args.branch,
    args.request,
    args.outcome,
  ]
    .map((value) => toLowerText(value))
    .join(" ");

  return haystack.includes(args.query);
}

function sortItemsByUpdatedAt(items: InboxItem[]): InboxItem[] {
  return items.toSorted(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );
}

export async function GET(req: Request) {
  const authSession = await getServerSession();
  if (!authSession?.user) {
    return Response.json({ error: "Not authenticated" }, { status: 401 });
  }

  const url = new URL(req.url);
  const query = toLowerText(url.searchParams.get("q")).trim();
  const includeUpdates = url.searchParams.get("includeUpdates") === "true";

  const sessionContexts = await getSessionInboxContexts(authSession.user.id);

  const groupedItems: Record<InboxGroup, InboxItem[]> = {
    action_required: [],
    review_ready: [],
    no_output: [],
    updates: [],
  };

  let remainingModelSummaries = MAX_MODEL_SUMMARIES_PER_REQUEST;

  for (const context of sessionContexts) {
    const {
      session,
      latestChatId,
      latestAssistantMessageAt,
      latestAssistantParts,
      firstUserMessageText,
      latestAssistantMessageText,
    } = context;

    if (session.status === "archived") {
      continue;
    }

    const toolSignals = getToolSignals(latestAssistantParts);

    const linesAdded = session.linesAdded ?? 0;
    const linesRemoved = session.linesRemoved ?? 0;
    const hasMeaningfulOutput =
      linesAdded > 0 ||
      linesRemoved > 0 ||
      session.prNumber !== null ||
      session.prStatus !== null;

    const hasFailure =
      session.status === "failed" ||
      session.lifecycleState === "failed" ||
      Boolean(session.lifecycleError) ||
      toolSignals.hasToolError;

    const eventType = deriveEventType({
      hasPendingQuestion: toolSignals.hasPendingQuestion,
      hasPendingApproval: toolSignals.hasPendingApproval,
      hasFailure,
      hasUnread: session.hasUnread,
      hasStreaming: session.hasStreaming,
      hasMeaningfulOutput,
    });

    if (!eventType) {
      continue;
    }

    if (eventType === "running_update" && !includeUpdates) {
      continue;
    }

    if (
      !includesQuery({
        query,
        title: session.title,
        repoOwner: session.repoOwner,
        repoName: session.repoName,
        branch: session.branch,
        request: firstUserMessageText,
        outcome: latestAssistantMessageText,
      })
    ) {
      continue;
    }

    const allowModelSummary =
      remainingModelSummaries > 0 && eventType !== "running_update";

    const contextSummary = await summarizeContext({
      request: firstUserMessageText,
      outcome: latestAssistantMessageText,
      eventType,
      allowModelSummary,
    });

    if (contextSummary.generatedByModel && allowModelSummary) {
      remainingModelSummaries -= 1;
    }

    const copy = getEventCopy(eventType);
    const group = getEventGroup(eventType);
    const timestamp =
      latestAssistantMessageAt ?? session.lastActivityAt ?? session.updatedAt;
    const sessionUrl = latestChatId
      ? `/sessions/${session.id}/chats/${latestChatId}`
      : `/sessions/${session.id}`;

    groupedItems[group].push({
      id: `${session.id}:${eventType}`,
      dedupeKey: `${session.id}:${eventType}`,
      group,
      eventType,
      severity: getEventSeverity(eventType),
      createdAt: timestamp.toISOString(),
      updatedAt: timestamp.toISOString(),
      title: copy.title,
      preview: contextSummary.summary,
      context: {
        request: contextSummary.request,
        outcome: contextSummary.outcome,
        generatedByModel: contextSummary.generatedByModel,
      },
      session: {
        sessionId: session.id,
        chatId: latestChatId,
        title: session.title,
        repoOwner: session.repoOwner,
        repoName: session.repoName,
        branch: session.branch,
        status: session.status,
      },
      badges: {
        hasUnread: session.hasUnread,
        hasStreaming: session.hasStreaming,
        linesAdded: session.linesAdded,
        linesRemoved: session.linesRemoved,
        prStatus: session.prStatus,
      },
      actions: [
        {
          type: "open_session",
          label: copy.primaryActionLabel,
          primary: true,
        },
        ...(eventType === "review_ready" ||
        eventType === "run_completed_no_output"
          ? [
              {
                type: "mark_done" as const,
                label: "Mark done",
              },
            ]
          : []),
      ],
      links: {
        sessionUrl,
      },
    });
  }

  const response: GetInboxResponse = {
    serverTime: new Date().toISOString(),
    counts: {
      total:
        groupedItems.action_required.length +
        groupedItems.review_ready.length +
        groupedItems.no_output.length +
        groupedItems.updates.length,
      actionRequired: groupedItems.action_required.length,
      reviewReady: groupedItems.review_ready.length,
      noOutput: groupedItems.no_output.length,
      updates: groupedItems.updates.length,
      running: sessionContexts.filter((context) => context.session.hasStreaming)
        .length,
    },
    groups: {
      actionRequired: sortItemsByUpdatedAt(groupedItems.action_required),
      reviewReady: sortItemsByUpdatedAt(groupedItems.review_ready),
      noOutput: sortItemsByUpdatedAt(groupedItems.no_output),
      updates: sortItemsByUpdatedAt(groupedItems.updates),
    },
  };

  return Response.json(response);
}
