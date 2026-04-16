import "server-only";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { decrypt, encrypt } from "@/lib/crypto";
import { db } from "@/lib/db/client";
import { vercelConnections } from "@/lib/db/schema";
import {
  VercelApiError,
  fetchVercelApi,
  isAuthenticationError,
} from "./api-client";
import { getUserVercelToken } from "./token";

/** How long before we proactively refresh the gateway key (4 hours). */
const GATEWAY_KEY_MAX_AGE_MS = 4 * 60 * 60 * 1000;

interface ExchangeApiKeyResponse {
  apiKeyString?: string;
}

/**
 * Exchange a Vercel access token for a team-scoped AI Gateway API key.
 *
 * This calls `POST /api-keys?teamId={teamId}` with `purpose: "ai-gateway"`
 * to create a key that bills usage to the specified team.
 */
async function exchangeTokenForGatewayKey(params: {
  token: string;
  teamId: string;
}): Promise<string> {
  // TODO: remove raw fetch debug after gateway-key exchange is working
  const url = `https://api.vercel.com/api-keys?teamId=${encodeURIComponent(params.teamId)}`;
  const body = JSON.stringify({
    purpose: "ai-gateway",
    name: "Open Harness Gateway Key",
    exchange: true,
  });

  console.log("[gateway-key] Exchange request:", { url, body });

  const rawResponse = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${params.token}`,
      "Content-Type": "application/json",
    },
    body,
  });

  const responseText = await rawResponse.text();
  console.log("[gateway-key] Exchange response:", {
    status: rawResponse.status,
    body: responseText.substring(0, 500),
  });

  if (!rawResponse.ok) {
    throw new VercelApiError(
      `Vercel API POST /api-keys failed (${rawResponse.status})`,
      rawResponse.status,
      responseText,
    );
  }

  const data = JSON.parse(responseText) as ExchangeApiKeyResponse;
  if (!data.apiKeyString) {
    throw new Error("Vercel API did not return an API key");
  }

  return data.apiKeyString;
}

/**
 * Obtain (or refresh) a gateway API key for the user's selected team.
 * Stores the encrypted key in the `vercel_connections` table.
 *
 * Returns the plaintext API key or null if the exchange failed.
 */
export async function obtainGatewayApiKey(params: {
  userId: string;
  teamId: string;
}): Promise<string | null> {
  const token = await getUserVercelToken(params.userId);
  if (!token) {
    return null;
  }

  // TODO: remove debug logging after gateway-key exchange is working
  console.log("[gateway-key] Debug:", {
    tokenPrefix: token.substring(0, 8) + "...",
    tokenLength: token.length,
    teamId: params.teamId,
    appClientId: process.env.NEXT_PUBLIC_VERCEL_APP_CLIENT_ID,
  });

  // Introspect the token to see what permissions it carries
  try {
    const introspectResponse = await fetch(
      "https://api.vercel.com/login/oauth/token/introspect",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token }),
      },
    );
    const introspectData = await introspectResponse.text();
    console.log("[gateway-key] Token introspection:", {
      status: introspectResponse.status,
      body: introspectData.substring(0, 1000),
    });
  } catch (introspectError) {
    console.error("[gateway-key] Token introspection failed:", introspectError);
  }

  try {
    const apiKey = await exchangeTokenForGatewayKey({
      token,
      teamId: params.teamId,
    });

    // Upsert the vercel_connections row
    const now = new Date();
    await db
      .insert(vercelConnections)
      .values({
        id: nanoid(),
        userId: params.userId,
        teamId: params.teamId,
        gatewayApiKey: encrypt(apiKey),
        gatewayApiKeyObtainedAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: vercelConnections.userId,
        set: {
          teamId: params.teamId,
          gatewayApiKey: encrypt(apiKey),
          gatewayApiKeyObtainedAt: now,
          updatedAt: now,
        },
      });

    return apiKey;
  } catch (error) {
    console.error("[gateway-key] Failed to exchange token for gateway key:", {
      error: error instanceof Error ? error.message : String(error),
      responseBody:
        error instanceof VercelApiError ? error.responseBody : undefined,
      teamId: params.teamId,
      isAuthError: isAuthenticationError(error),
    });
    return null;
  }
}

/**
 * Get the user's current gateway API key, refreshing if stale.
 *
 * Returns `{ apiKey, teamId }` or null if no gateway key is configured.
 */
export async function getUserGatewayConfig(
  userId: string,
): Promise<{ apiKey: string; teamId: string } | null> {
  const [row] = await db
    .select({
      gatewayApiKey: vercelConnections.gatewayApiKey,
      gatewayApiKeyObtainedAt: vercelConnections.gatewayApiKeyObtainedAt,
      teamId: vercelConnections.teamId,
    })
    .from(vercelConnections)
    .where(eq(vercelConnections.userId, userId))
    .limit(1);

  if (!row?.gatewayApiKey || !row?.teamId) {
    return null;
  }

  // Check if key needs proactive refresh
  const needsRefresh =
    !row.gatewayApiKeyObtainedAt ||
    Date.now() - row.gatewayApiKeyObtainedAt.getTime() > GATEWAY_KEY_MAX_AGE_MS;

  if (needsRefresh) {
    const freshKey = await obtainGatewayApiKey({
      userId,
      teamId: row.teamId,
    });

    if (freshKey) {
      return { apiKey: freshKey, teamId: row.teamId };
    }

    // Fall through to use the existing key if refresh failed
  }

  try {
    return {
      apiKey: decrypt(row.gatewayApiKey),
      teamId: row.teamId,
    };
  } catch {
    return null;
  }
}

/**
 * Clear the user's gateway API key and team selection.
 */
export async function clearGatewayConfig(userId: string): Promise<void> {
  await db
    .delete(vercelConnections)
    .where(eq(vercelConnections.userId, userId));
}
