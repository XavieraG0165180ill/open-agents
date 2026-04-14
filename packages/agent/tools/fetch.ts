import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { tool } from "ai";
import { z } from "zod";

const fetchInputSchema = z.object({
  url: z.string().url().describe("The URL to fetch"),
  method: z
    .enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"])
    .optional()
    .describe("HTTP method. Default: GET"),
  headers: z
    .record(z.string(), z.string())
    .optional()
    .describe("Optional HTTP headers as key-value pairs"),
  body: z
    .string()
    .optional()
    .describe("Optional request body (for POST/PUT/PATCH)"),
});

type LookupResult = { address: string; family: number }[];
type WebFetchLookup = (hostname: string) => Promise<LookupResult>;

function getWebFetchLookup(experimentalContext: unknown): WebFetchLookup {
  if (experimentalContext && typeof experimentalContext === "object") {
    const lookupOverride = Reflect.get(
      experimentalContext,
      "webFetchDnsLookup",
    );
    if (typeof lookupOverride === "function") {
      return lookupOverride as WebFetchLookup;
    }
  }

  return async (hostname: string) => {
    const result = await dnsLookup(hostname, {
      all: true,
      verbatim: true,
    });
    return result.map((entry) => ({
      address: entry.address,
      family: entry.family,
    }));
  };
}

function normalizeHostname(hostname: string): string {
  const trimmed = hostname.trim().toLowerCase();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

function isPrivateHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  );
}

function isPrivateIpv4(address: string): boolean {
  const octets = address.split(".").map((part) => Number.parseInt(part, 10));
  if (octets.length !== 4 || octets.some((value) => Number.isNaN(value))) {
    return true;
  }

  const [first, second] = octets;
  if (first === undefined || second === undefined) {
    return true;
  }

  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0) ||
    (first === 192 && second === 168) ||
    (first === 198 && second >= 18 && second <= 19) ||
    first >= 224
  );
}

function isPrivateIpv6(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized === "::" || normalized === "::1") {
    return true;
  }

  if (normalized.startsWith("::ffff:")) {
    return isPrivateIpAddress(normalized.slice("::ffff:".length));
  }

  if (normalized.startsWith("fc") || normalized.startsWith("fd")) {
    return true;
  }

  if (/^fe[89ab]/.test(normalized)) {
    return true;
  }

  return false;
}

function isPrivateIpAddress(address: string): boolean {
  const normalized = normalizeHostname(address);
  const family = isIP(normalized);
  if (family === 4) {
    return isPrivateIpv4(normalized);
  }

  if (family === 6) {
    return isPrivateIpv6(normalized);
  }

  return true;
}

async function validateFetchUrl(
  url: string,
  lookupHost: WebFetchLookup,
): Promise<{ ok: true; parsedUrl: URL } | { ok: false; error: string }> {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return {
      ok: false,
      error: "Fetch failed: Invalid URL",
    };
  }

  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    return {
      ok: false,
      error: "Fetch failed: Only http and https URLs are allowed",
    };
  }

  const hostname = normalizeHostname(parsedUrl.hostname);
  if (!hostname || isPrivateHostname(hostname)) {
    return {
      ok: false,
      error: "Fetch failed: Private or local network URLs are not allowed",
    };
  }

  if (isIP(hostname)) {
    if (isPrivateIpAddress(hostname)) {
      return {
        ok: false,
        error: "Fetch failed: Private or local network URLs are not allowed",
      };
    }

    return { ok: true, parsedUrl };
  }

  let resolvedAddresses: LookupResult;
  try {
    resolvedAddresses = await lookupHost(hostname);
  } catch {
    return {
      ok: false,
      error: "Fetch failed: Could not resolve URL hostname",
    };
  }

  if (
    resolvedAddresses.length === 0 ||
    resolvedAddresses.some((entry) => isPrivateIpAddress(entry.address))
  ) {
    return {
      ok: false,
      error: "Fetch failed: Private or local network URLs are not allowed",
    };
  }

  return { ok: true, parsedUrl };
}

export const webFetchTool = tool({
  description: `Fetch a URL from the web.

USAGE:
- Make HTTP requests to external URLs
- Supports GET, POST, PUT, PATCH, DELETE, and HEAD methods
- Returns the response status, headers, and body text
- Body is truncated to 20000 characters to avoid overwhelming context

EXAMPLES:
- Simple GET: url: "https://api.example.com/data"
- POST with JSON: url: "https://api.example.com/items", method: "POST", headers: {"Content-Type": "application/json"}, body: "{\\"name\\":\\"item\\"}"`,
  inputSchema: fetchInputSchema,
  execute: async (
    { url, method = "GET", headers, body },
    { experimental_context },
  ) => {
    try {
      const MAX_BODY_LENGTH = 20000;
      const validation = await validateFetchUrl(
        url,
        getWebFetchLookup(experimental_context),
      );
      if (!validation.ok) {
        return {
          success: false,
          error: validation.error,
        };
      }

      const init: RequestInit = {
        method,
        headers,
        redirect: "manual",
        signal: AbortSignal.timeout(30000),
      };
      if (method !== "GET" && method !== "HEAD" && body) {
        init.body = body;
      }
      const response = await fetch(validation.parsedUrl.toString(), init);

      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });

      let responseBody: string;
      try {
        responseBody = await response.text();
      } catch {
        responseBody = "[Could not read response body]";
      }

      const truncated = responseBody.length > MAX_BODY_LENGTH;
      if (truncated) {
        responseBody = responseBody.slice(0, MAX_BODY_LENGTH);
      }

      return {
        success: true,
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
        body: responseBody,
        truncated,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: `Fetch failed: ${message}`,
      };
    }
  },
});
