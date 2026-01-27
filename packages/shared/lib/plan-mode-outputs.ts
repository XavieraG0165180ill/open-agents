/**
 * Plan mode output types and extraction utilities.
 * These are browser-safe and can be imported in client components.
 */

// Enter plan mode output types and helpers

export type EnterPlanModeOutput = {
  success: boolean;
  message: string;
  planFilePath: string;
  planName: string;
};

export function isEnterPlanModeOutput(
  value: unknown,
): value is EnterPlanModeOutput {
  // AI SDK wraps tool results in { type: "json", value: {...} }
  // Unwrap if necessary
  const unwrapped =
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    "value" in value
      ? (value as { type: string; value: unknown }).value
      : value;

  return (
    typeof unwrapped === "object" &&
    unwrapped !== null &&
    "success" in unwrapped &&
    "planFilePath" in unwrapped &&
    (unwrapped as EnterPlanModeOutput).success === true
  );
}

/**
 * Extract the actual output value from a potentially wrapped tool result.
 */
export function extractEnterPlanModeOutput(
  value: unknown,
): EnterPlanModeOutput | null {
  const unwrapped =
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    "value" in value
      ? (value as { type: string; value: unknown }).value
      : value;

  if (isEnterPlanModeOutput(unwrapped)) {
    return unwrapped as EnterPlanModeOutput;
  }
  return null;
}

// Exit plan mode output types and helpers

export type ExitPlanModeInput = {
  _: string;
  allowedPrompts?: Array<{
    tool: "bash";
    prompt: string;
  }>;
};

export type ExitPlanModeOutput = {
  success: boolean;
  message?: string;
  error?: string;
  plan: string | null;
  planFilePath: string | null;
  allowedPrompts?: ExitPlanModeInput["allowedPrompts"];
};

export function isExitPlanModeOutput(
  value: unknown,
): value is ExitPlanModeOutput {
  // AI SDK wraps tool results in { type: "json", value: {...} }
  // Unwrap if necessary
  const unwrapped =
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    "value" in value
      ? (value as { type: string; value: unknown }).value
      : value;

  return (
    typeof unwrapped === "object" &&
    unwrapped !== null &&
    "success" in unwrapped &&
    "plan" in unwrapped &&
    (unwrapped as ExitPlanModeOutput).success === true
  );
}

/**
 * Extract a successful exit_plan_mode output from a potentially wrapped tool result.
 * Returns null if the output is not present, invalid, or indicates failure (success !== true).
 * This ensures mode transitions only occur when the tool execution succeeded.
 */
export function extractExitPlanModeOutput(
  value: unknown,
): ExitPlanModeOutput | null {
  const unwrapped =
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    "value" in value
      ? (value as { type: string; value: unknown }).value
      : value;

  if (
    typeof unwrapped === "object" &&
    unwrapped !== null &&
    "success" in unwrapped &&
    "plan" in unwrapped &&
    (unwrapped as ExitPlanModeOutput).success === true
  ) {
    return unwrapped as ExitPlanModeOutput;
  }
  return null;
}
