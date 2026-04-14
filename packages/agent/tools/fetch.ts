import { tool } from "ai";
import { z } from "zod";

const fetchInputSchema = z.object({
  url: z.string().url().describe("The URL to fetch"),
  method: z
    .literal("GET")
    .optional()
    .describe("HTTP method. Only GET is supported."),
  headers: z
    .record(z.string(), z.string())
    .optional()
    .describe("Optional HTTP headers as key-value pairs"),
});

export const webFetchTool = tool({
  description: `Fetch a URL from the web using GET requests only.

USAGE:
- Make GET requests to external URLs
- Optional headers are supported
- Returns the response status, headers, and body text
- Body is truncated to 20000 characters to avoid overwhelming context

EXAMPLES:
- Simple GET: url: "https://api.example.com/data"
- GET with headers: url: "https://api.example.com/data", headers: {"Accept": "application/json"}`,
  inputSchema: fetchInputSchema,
  execute: async ({ url, headers }) => {
    try {
      const MAX_BODY_LENGTH = 20000;

      const response = await fetch(url, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(30000),
      });

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
