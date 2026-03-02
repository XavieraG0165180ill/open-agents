import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import type { WebAgentUIMessage } from "@/app/types";
import { DiffsProvider } from "@/components/diffs-provider";
import { getChatById, getChatMessages } from "@/lib/db/sessions";
import { getSessionByIdCached } from "@/lib/db/sessions-cache";
import { getUserPreferences } from "@/lib/db/user-preferences";
import { type AvailableModel, getModelDisplayName } from "@/lib/models";
import { fetchAvailableLanguageModelsWithContext } from "@/lib/models-with-context";
import { getServerSession } from "@/lib/session/get-server-session";
import { SessionChatContent } from "./session-chat-content";
import { SessionChatProvider } from "./session-chat-context";

interface SessionChatPageProps {
  params: Promise<{ sessionId: string; chatId: string }>;
}

type SessionChatModelOption = {
  id: string;
  label: string;
  description: string;
  isVariant: boolean;
};

type UserModelVariant = Awaited<
  ReturnType<typeof getUserPreferences>
>["modelVariants"][number];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isOptimisticChatId(chatId: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    chatId,
  );
}

const OPTIMISTIC_CHAT_RETRY_DELAY_MS = 100;
const OPTIMISTIC_CHAT_RETRY_ATTEMPTS = 50;

async function getInitialModels() {
  try {
    return await fetchAvailableLanguageModelsWithContext();
  } catch {
    return [];
  }
}

function buildSessionChatModelOptions(
  models: AvailableModel[],
  modelVariants: UserModelVariant[],
): SessionChatModelOption[] {
  const modelNameById = new Map(
    models.map((model) => [model.id, getModelDisplayName(model)]),
  );

  const baseModelOptions: SessionChatModelOption[] = models.map((model) => ({
    id: model.id,
    label: getModelDisplayName(model),
    description: model.id,
    isVariant: false,
  }));

  const optionIds = new Set(baseModelOptions.map((option) => option.id));
  const variantOptions: SessionChatModelOption[] = modelVariants
    .filter((variant) => !optionIds.has(variant.id))
    .map((variant) => {
      const baseModelName = modelNameById.get(variant.baseModelId);
      return {
        id: variant.id,
        label: variant.name,
        description: baseModelName
          ? `Variant of ${baseModelName}`
          : `Variant of ${variant.baseModelId}`,
        isVariant: true,
      };
    });

  return [...baseModelOptions, ...variantOptions];
}

async function getChatByIdWithRetry(
  chatId: string,
  sessionId: string,
): Promise<Awaited<ReturnType<typeof getChatById>>> {
  const maxAttempts = isOptimisticChatId(chatId)
    ? OPTIMISTIC_CHAT_RETRY_ATTEMPTS
    : 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const chat = await getChatById(chatId);
    if (chat && chat.sessionId === sessionId) {
      return chat;
    }
    if (attempt < maxAttempts) {
      await sleep(OPTIMISTIC_CHAT_RETRY_DELAY_MS);
    }
  }
  return undefined;
}

export async function generateMetadata({
  params,
}: SessionChatPageProps): Promise<Metadata> {
  const { sessionId } = await params;
  const sessionRecord = await getSessionByIdCached(sessionId);

  return {
    title: sessionRecord?.title ?? `Session ${sessionId}`,
    description: "Review session progress, chats, and outputs.",
  };
}

export default async function SessionChatPage({
  params,
}: SessionChatPageProps) {
  const { sessionId, chatId } = await params;

  // Start independent fetches in parallel
  const sessionPromise = getServerSession();
  const sessionRecordPromise = getSessionByIdCached(sessionId);

  // Server-side auth check
  const session = await sessionPromise;
  if (!session?.user) {
    redirect("/");
  }

  // Fetch session record
  const sessionRecord = await sessionRecordPromise;
  if (!sessionRecord) {
    notFound();
  }

  // Check ownership
  if (sessionRecord.userId !== session.user.id) {
    redirect("/");
  }

  // Fetch chat, messages, models, and user model variants in parallel
  const [chat, dbMessages, initialModels, preferences] = await Promise.all([
    getChatByIdWithRetry(chatId, sessionId),
    getChatMessages(chatId),
    getInitialModels(),
    getUserPreferences(session.user.id),
  ]);

  if (!chat) {
    if (isOptimisticChatId(chatId)) {
      redirect(`/sessions/${sessionId}`);
    }
    notFound();
  }

  const modelOptions = buildSessionChatModelOptions(
    initialModels,
    preferences.modelVariants ?? [],
  );

  const initialMessages = dbMessages.map((m) => m.parts as WebAgentUIMessage);

  return (
    <DiffsProvider>
      <SessionChatProvider
        session={sessionRecord}
        chat={chat}
        initialMessages={initialMessages}
      >
        <SessionChatContent
          initialModels={initialModels}
          modelOptions={modelOptions}
        />
      </SessionChatProvider>
    </DiffsProvider>
  );
}
