import { asc, desc, inArray } from "drizzle-orm";
import { db } from "./client";
import { chatMessages, chats } from "./schema";
import {
  type SessionWithUnread,
  getSessionsWithUnreadByUserId,
} from "./sessions";

export interface SessionInboxContext {
  session: SessionWithUnread;
  latestChatId: string | null;
  latestAssistantParts: unknown[] | null;
  latestAssistantMessageAt: Date | null;
  firstUserMessageText: string | null;
  latestAssistantMessageText: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toMessageParts(value: unknown): unknown[] | null {
  if (Array.isArray(value)) {
    return value;
  }

  if (isRecord(value) && Array.isArray(value.parts)) {
    return value.parts;
  }

  return null;
}

function extractMessageText(value: unknown): string | null {
  const parts = toMessageParts(value);
  if (!parts) {
    return null;
  }

  const text = parts
    .flatMap((part) => {
      if (!isRecord(part)) {
        return [];
      }

      if (part.type === "text" && typeof part.text === "string") {
        return [part.text];
      }

      return [];
    })
    .join("\n")
    .trim();

  return text.length > 0 ? text : null;
}

export async function getSessionInboxContexts(
  userId: string,
): Promise<SessionInboxContext[]> {
  const userSessions = await getSessionsWithUnreadByUserId(userId);

  if (userSessions.length === 0) {
    return [];
  }

  const sessionIds = userSessions.map((session) => session.id);

  const chatRows = await db
    .select({
      id: chats.id,
      sessionId: chats.sessionId,
      createdAt: chats.createdAt,
    })
    .from(chats)
    .where(inArray(chats.sessionId, sessionIds))
    .orderBy(desc(chats.createdAt));

  const latestChatBySession = new Map<
    string,
    { id: string; createdAt: Date | null }
  >();

  for (const chatRow of chatRows) {
    if (!latestChatBySession.has(chatRow.sessionId)) {
      latestChatBySession.set(chatRow.sessionId, {
        id: chatRow.id,
        createdAt: chatRow.createdAt,
      });
    }
  }

  const latestChatIds = Array.from(latestChatBySession.values()).map(
    (chatRow) => chatRow.id,
  );

  const firstUserMessageByChatId = new Map<string, string | null>();
  const latestAssistantByChatId = new Map<
    string,
    {
      text: string | null;
      parts: unknown[] | null;
      createdAt: Date | null;
    }
  >();

  if (latestChatIds.length > 0) {
    const messageRows = await db
      .select({
        chatId: chatMessages.chatId,
        role: chatMessages.role,
        createdAt: chatMessages.createdAt,
        payload: chatMessages.parts,
      })
      .from(chatMessages)
      .where(inArray(chatMessages.chatId, latestChatIds))
      .orderBy(asc(chatMessages.createdAt));

    for (const messageRow of messageRows) {
      if (messageRow.role === "user") {
        if (!firstUserMessageByChatId.has(messageRow.chatId)) {
          firstUserMessageByChatId.set(
            messageRow.chatId,
            extractMessageText(messageRow.payload),
          );
        }
        continue;
      }

      if (messageRow.role === "assistant") {
        latestAssistantByChatId.set(messageRow.chatId, {
          text: extractMessageText(messageRow.payload),
          parts: toMessageParts(messageRow.payload),
          createdAt: messageRow.createdAt,
        });
      }
    }
  }

  return userSessions.map((session) => {
    const latestChat = latestChatBySession.get(session.id);
    const latestAssistant = latestChat
      ? latestAssistantByChatId.get(latestChat.id)
      : undefined;

    return {
      session,
      latestChatId: latestChat?.id ?? null,
      latestAssistantParts: latestAssistant?.parts ?? null,
      latestAssistantMessageAt: latestAssistant?.createdAt ?? null,
      firstUserMessageText: latestChat
        ? (firstUserMessageByChatId.get(latestChat.id) ?? null)
        : null,
      latestAssistantMessageText: latestAssistant?.text ?? null,
    };
  });
}
