import { createRedisClient, isRedisConfigured } from "@/lib/redis";

interface TakeRateLimitOptions {
  scope: string;
  identifier: string;
  limit: number;
  windowMs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
}

type InMemoryCounter = {
  count: number;
  expiresAt: number;
};

const inMemoryCounters = new Map<string, InMemoryCounter>();
let sharedRedisClient: ReturnType<typeof createRedisClient> | null | undefined;
let warnedRedisRateLimitFailure = false;

function getWindowKey(now: number, windowMs: number): string {
  return String(Math.floor(now / windowMs));
}

function getRateLimitKey(
  scope: string,
  identifier: string,
  now: number,
  windowMs: number,
): string {
  return `rate-limit:${scope}:${identifier}:${getWindowKey(now, windowMs)}`;
}

function getWindowExpiresAt(now: number, windowMs: number): number {
  return (Math.floor(now / windowMs) + 1) * windowMs;
}

function buildRateLimitResult(
  count: number,
  limit: number,
  retryAfterMs: number,
): RateLimitResult {
  return {
    allowed: count <= limit,
    limit,
    remaining: Math.max(limit - count, 0),
    retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)),
  };
}

function cleanupExpiredInMemoryCounters(now: number): void {
  for (const [key, counter] of inMemoryCounters.entries()) {
    if (counter.expiresAt <= now) {
      inMemoryCounters.delete(key);
    }
  }
}

function takeInMemoryRateLimit(
  options: TakeRateLimitOptions,
  now: number,
): RateLimitResult {
  cleanupExpiredInMemoryCounters(now);

  const key = getRateLimitKey(
    options.scope,
    options.identifier,
    now,
    options.windowMs,
  );
  const expiresAt = getWindowExpiresAt(now, options.windowMs);
  const current = inMemoryCounters.get(key);
  const count = (current?.count ?? 0) + 1;

  inMemoryCounters.set(key, {
    count,
    expiresAt,
  });

  return buildRateLimitResult(count, options.limit, expiresAt - now);
}

function getSharedRedisClient() {
  if (sharedRedisClient !== undefined) {
    return sharedRedisClient;
  }

  if (!isRedisConfigured()) {
    sharedRedisClient = null;
    return sharedRedisClient;
  }

  try {
    sharedRedisClient = createRedisClient("rate-limit");
  } catch (error) {
    if (!warnedRedisRateLimitFailure) {
      warnedRedisRateLimitFailure = true;
      console.error(
        "[rate-limit] Failed to initialize Redis client, using in-memory fallback:",
        error instanceof Error ? error.message : String(error),
      );
    }
    sharedRedisClient = null;
  }

  return sharedRedisClient;
}

async function takeRedisRateLimit(
  options: TakeRateLimitOptions,
  now: number,
): Promise<RateLimitResult | null> {
  const redisClient = getSharedRedisClient();
  if (!redisClient) {
    return null;
  }

  const key = getRateLimitKey(
    options.scope,
    options.identifier,
    now,
    options.windowMs,
  );
  const defaultRetryAfterMs = getWindowExpiresAt(now, options.windowMs) - now;

  try {
    const count = await redisClient.incr(key);

    if (count === 1) {
      await redisClient.pexpire(key, options.windowMs);
    }

    let retryAfterMs = await redisClient.pttl(key);
    if (retryAfterMs < 0) {
      retryAfterMs = defaultRetryAfterMs;
      await redisClient.pexpire(key, retryAfterMs);
    }

    return buildRateLimitResult(count, options.limit, retryAfterMs);
  } catch (error) {
    if (!warnedRedisRateLimitFailure) {
      warnedRedisRateLimitFailure = true;
      console.error(
        "[rate-limit] Redis request failed, using in-memory fallback:",
        error instanceof Error ? error.message : String(error),
      );
    }
    return null;
  }
}

export async function takeRateLimit(
  options: TakeRateLimitOptions,
): Promise<RateLimitResult> {
  const now = Date.now();
  const redisResult = await takeRedisRateLimit(options, now);
  if (redisResult) {
    return redisResult;
  }

  return takeInMemoryRateLimit(options, now);
}

export function createRateLimitResponse(
  result: RateLimitResult,
  message = "Too many requests. Please try again later.",
): Response {
  return Response.json(
    {
      error: message,
    },
    {
      status: 429,
      headers: {
        "Retry-After": String(result.retryAfterSeconds),
        "X-RateLimit-Limit": String(result.limit),
        "X-RateLimit-Remaining": String(result.remaining),
      },
    },
  );
}
