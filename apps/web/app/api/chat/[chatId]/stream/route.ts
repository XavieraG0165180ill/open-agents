import { createUIMessageStreamResponse, type InferUIMessageChunk } from "ai";
import { getRun } from "workflow/api";
import {
  requireAuthenticatedUser,
  requireOwnedChatById,
} from "@/app/api/chat/_lib/chat-context";
import type { WebAgentUIMessage } from "@/app/types";
import { updateChatActiveStreamId } from "@/lib/db/sessions";
import { createCancelableReadableStream } from "@/lib/chat/create-cancelable-readable-stream";

const STREAM_RUN_ID_QUERY_PARAM = "runId";
const STREAM_START_INDEX_QUERY_PARAM = "startIndex";
const WORKFLOW_RUN_ID_HEADER = "x-workflow-run-id";
const MAX_STREAM_START_INDEX = 1_000_000;

type RouteContext = {
  params: Promise<{ chatId: string }>;
};

type WebAgentUIMessageChunk = InferUIMessageChunk<WebAgentUIMessage>;

export async function GET(request: Request, context: RouteContext) {
  const authResult = await requireAuthenticatedUser("text");
  if (!authResult.ok) {
    return authResult.response;
  }

  const { chatId } = await context.params;

  const chatContext = await requireOwnedChatById({
    userId: authResult.userId,
    chatId,
    format: "text",
  });
  if (!chatContext.ok) {
    return chatContext.response;
  }

  const { chat } = chatContext;

  if (!chat.activeStreamId) {
    return new Response(null, { status: 204 });
  }

  const runId = chat.activeStreamId;
  const streamStartIndex = getStreamStartIndexForRun(request, runId);

  try {
    const run = getRun(runId);
    const status = await run.status;

    if (
      status === "completed" ||
      status === "cancelled" ||
      status === "failed"
    ) {
      // Workflow is done — clear the stale activeStreamId.
      await updateChatActiveStreamId(chatId, null);
      return new Response(null, { status: 204 });
    }

    const stream = createCancelableReadableStream(
      run.getReadable<WebAgentUIMessageChunk>(
        streamStartIndex === undefined
          ? undefined
          : {
              startIndex: streamStartIndex,
            },
      ),
    );

    return createUIMessageStreamResponse({
      stream,
      headers: {
        [WORKFLOW_RUN_ID_HEADER]: runId,
      },
    });
  } catch {
    // Workflow run not found or inaccessible — clear stale ID.
    await updateChatActiveStreamId(chatId, null);
    return new Response(null, { status: 204 });
  }
}

function getStreamStartIndexForRun(
  request: Request,
  activeRunId: string,
): number | undefined {
  const url = new URL(request.url);
  const requestedRunId = url.searchParams.get(STREAM_RUN_ID_QUERY_PARAM);
  if (!requestedRunId || requestedRunId !== activeRunId) {
    return undefined;
  }

  return parseStreamStartIndex(
    url.searchParams.get(STREAM_START_INDEX_QUERY_PARAM),
  );
}

function parseStreamStartIndex(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return undefined;
  }

  return Math.min(parsed, MAX_STREAM_START_INDEX);
}
