import type { FetchFunction } from "@ai-sdk/provider-utils";
import type { UIMessage } from "ai";
import { DefaultChatTransport } from "ai";

const STREAM_CURSOR_STORAGE_KEY_PREFIX = "open-harness:chat-stream-cursor:";
const STREAM_CURSOR_PERSIST_INTERVAL_CHUNKS = 25;
const STREAM_RUN_ID_QUERY_PARAM = "runId";
const STREAM_START_INDEX_QUERY_PARAM = "startIndex";
const WORKFLOW_RUN_ID_HEADER = "x-workflow-run-id";

type ByteStream = ReadableStream<Uint8Array<ArrayBufferLike>>;

type ChatStreamCursor = {
  runId: string;
  nextChunkIndex: number;
};

type StreamTrackingContext = ChatStreamCursor & {
  chatId: string;
};

const streamCursorCache = new Map<string, ChatStreamCursor>();

function getCursorStorageKey(chatId: string): string {
  return `${STREAM_CURSOR_STORAGE_KEY_PREFIX}${chatId}`;
}

function readChatStreamCursor(chatId: string): ChatStreamCursor | null {
  const cached = streamCursorCache.get(chatId);
  if (cached) {
    return cached;
  }

  if (typeof window === "undefined") {
    return null;
  }

  try {
    const raw = window.sessionStorage.getItem(getCursorStorageKey(chatId));
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as {
      runId?: unknown;
      nextChunkIndex?: unknown;
    };

    const nextChunkIndex =
      typeof parsed.nextChunkIndex === "number" ? parsed.nextChunkIndex : null;

    if (
      typeof parsed.runId !== "string" ||
      nextChunkIndex === null ||
      !Number.isInteger(nextChunkIndex) ||
      nextChunkIndex < 0
    ) {
      return null;
    }

    const cursor: ChatStreamCursor = {
      runId: parsed.runId,
      nextChunkIndex,
    };

    streamCursorCache.set(chatId, cursor);
    return cursor;
  } catch {
    return null;
  }
}

function writeChatStreamCursor(chatId: string, cursor: ChatStreamCursor): void {
  streamCursorCache.set(chatId, cursor);

  if (typeof window === "undefined") {
    return;
  }

  try {
    window.sessionStorage.setItem(
      getCursorStorageKey(chatId),
      JSON.stringify(cursor),
    );
  } catch {
    // Ignore storage write failures (private mode / quota) and keep in-memory cache.
  }
}

function getResumeStartIndex(chatId: string, runId: string): number {
  const cursor = readChatStreamCursor(chatId);
  if (!cursor || cursor.runId !== runId) {
    return 0;
  }

  return cursor.nextChunkIndex;
}

function getRequestBaseUrl(): string {
  if (typeof window !== "undefined") {
    return window.location.origin;
  }

  return "http://localhost";
}

function resolveRequestMethod(
  input: RequestInfo | URL,
  init?: RequestInit,
): string {
  if (init?.method) {
    return init.method.toUpperCase();
  }

  if (typeof Request !== "undefined" && input instanceof Request) {
    return input.method.toUpperCase();
  }

  return "GET";
}

function resolveRequestUrl(input: RequestInfo | URL): URL | null {
  try {
    if (input instanceof URL) {
      return new URL(input.toString(), getRequestBaseUrl());
    }

    if (typeof input === "string") {
      return new URL(input, getRequestBaseUrl());
    }

    if (typeof Request !== "undefined" && input instanceof Request) {
      return new URL(input.url, getRequestBaseUrl());
    }

    return null;
  } catch {
    return null;
  }
}

function parseChatIdFromStreamPath(pathname: string): string | null {
  const match = pathname.match(/^\/api\/chat\/([^/]+)\/stream$/);
  if (!match?.[1]) {
    return null;
  }

  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

function parseChatIdFromPostBody(init?: RequestInit): string | null {
  if (typeof init?.body !== "string") {
    return null;
  }

  try {
    const parsed = JSON.parse(init.body) as {
      chatId?: unknown;
      id?: unknown;
    };

    if (typeof parsed.chatId === "string") {
      return parsed.chatId;
    }

    if (typeof parsed.id === "string") {
      return parsed.id;
    }

    return null;
  } catch {
    return null;
  }
}

function isReconnectRequest(
  method: string,
  requestUrl: URL | null,
): requestUrl is URL {
  return (
    method === "GET" &&
    !!requestUrl &&
    !!parseChatIdFromStreamPath(requestUrl.pathname)
  );
}

function withResumeCursor(url: URL, cursor: ChatStreamCursor): URL {
  const nextUrl = new URL(url.toString());

  nextUrl.searchParams.set(STREAM_RUN_ID_QUERY_PARAM, cursor.runId);
  nextUrl.searchParams.set(
    STREAM_START_INDEX_QUERY_PARAM,
    cursor.nextChunkIndex.toString(),
  );

  return nextUrl;
}

/**
 * A chat transport that allows aborting ALL active fetch connections,
 * including `reconnectToStream` requests.
 *
 * The AI SDK's `reconnectToStream` does not pass an abort signal to its
 * internal fetch call, so `chatInstance.stop()` cannot cancel resumed
 * streams. This transport wraps every fetch with a transport-level abort
 * signal so that `abort()` reliably tears down any active connection.
 *
 * For resumed streams, the transport also tracks the last consumed chunk index
 * per chat in `sessionStorage` and reconnects with `{ runId, startIndex }`.
 * This prevents replaying the entire stream history after a page refresh.
 *
 * After `abort()` the transport is immediately reusable — a fresh controller
 * is created so that subsequent fetches are not affected. This makes it safe
 * to call from React effect cleanup (including Strict Mode double-mounts).
 */
export class AbortableChatTransport<
  UI_MESSAGE extends UIMessage = UIMessage,
> extends DefaultChatTransport<UI_MESSAGE> {
  private _state: {
    controller: AbortController;
    streamContexts: Map<ByteStream, StreamTrackingContext>;
  };

  constructor(
    options: ConstructorParameters<typeof DefaultChatTransport<UI_MESSAGE>>[0],
  ) {
    // Mutable ref so the fetch wrapper always reads the *current* controller,
    // even after abort() swaps it out.
    const state: {
      controller: AbortController;
      streamContexts: Map<ByteStream, StreamTrackingContext>;
    } = {
      controller: new AbortController(),
      streamContexts: new Map<ByteStream, StreamTrackingContext>(),
    };
    const outerFetch: FetchFunction = options?.fetch ?? globalThis.fetch;

    super({
      ...options,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const method = resolveRequestMethod(input, init);
        let requestUrl = resolveRequestUrl(input);
        let chatId =
          parseChatIdFromStreamPath(requestUrl?.pathname ?? "") ??
          parseChatIdFromPostBody(init);

        let requestInput = input;

        if (chatId && isReconnectRequest(method, requestUrl)) {
          const cursor = readChatStreamCursor(chatId);
          if (
            cursor &&
            cursor.nextChunkIndex > 0 &&
            !requestUrl.searchParams.has(STREAM_RUN_ID_QUERY_PARAM) &&
            !requestUrl.searchParams.has(STREAM_START_INDEX_QUERY_PARAM)
          ) {
            requestUrl = withResumeCursor(requestUrl, cursor);
            requestInput = requestUrl.toString();
          }
        }

        const response = await outerFetch(requestInput, {
          ...init,
          signal: init?.signal
            ? AbortSignal.any([state.controller.signal, init.signal])
            : state.controller.signal,
        });

        if (!chatId && requestUrl) {
          chatId = parseChatIdFromStreamPath(requestUrl.pathname);
        }

        const runId = response.headers.get(WORKFLOW_RUN_ID_HEADER);
        if (response.body && runId && chatId) {
          const nextChunkIndex = getResumeStartIndex(chatId, runId);

          writeChatStreamCursor(chatId, {
            runId,
            nextChunkIndex,
          });

          state.streamContexts.set(response.body as ByteStream, {
            chatId,
            runId,
            nextChunkIndex,
          });
        }

        return response;
      }) as FetchFunction,
    });

    this._state = state;
  }

  protected override processResponseStream(
    stream: ReadableStream<Uint8Array<ArrayBufferLike>>,
  ) {
    const messageStream = super.processResponseStream(stream);
    const trackingContext = this._state.streamContexts.get(
      stream as ByteStream,
    );

    if (!trackingContext) {
      return messageStream;
    }

    this._state.streamContexts.delete(stream as ByteStream);

    let nextChunkIndex = trackingContext.nextChunkIndex;
    let lastPersistedChunkIndex = nextChunkIndex;

    return messageStream.pipeThrough(
      new TransformStream({
        transform(chunk, controller) {
          nextChunkIndex += 1;

          if (
            nextChunkIndex - lastPersistedChunkIndex >=
            STREAM_CURSOR_PERSIST_INTERVAL_CHUNKS
          ) {
            writeChatStreamCursor(trackingContext.chatId, {
              runId: trackingContext.runId,
              nextChunkIndex,
            });
            lastPersistedChunkIndex = nextChunkIndex;
          }

          controller.enqueue(chunk);
        },
        flush() {
          if (nextChunkIndex === lastPersistedChunkIndex) {
            return;
          }

          writeChatStreamCursor(trackingContext.chatId, {
            runId: trackingContext.runId,
            nextChunkIndex,
          });
        },
      }),
    );
  }

  /**
   * Abort every in-flight fetch made through this transport, then reset
   * so new requests go through normally.
   */
  abort(): void {
    this._state.controller.abort();
    this._state.controller = new AbortController();
  }
}
