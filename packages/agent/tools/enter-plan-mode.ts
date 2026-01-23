import { tool } from "ai";
import { z } from "zod";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";

// Word lists for generating random plan names
const ADJECTIVES = [
  "giggling",
  "dancing",
  "sleeping",
  "running",
  "jumping",
  "singing",
  "floating",
  "spinning",
  "glowing",
  "buzzing",
  "flying",
  "crawling",
  "bouncing",
  "whistling",
  "humming",
  "drifting",
  "twirling",
  "shimmering",
  "sparkling",
  "flickering",
  "swaying",
  "tumbling",
  "soaring",
  "prancing",
  "skipping",
];

const COLORS = [
  "crimson",
  "azure",
  "golden",
  "silver",
  "coral",
  "violet",
  "emerald",
  "amber",
  "ivory",
  "jade",
  "scarlet",
  "cobalt",
  "copper",
  "indigo",
  "bronze",
  "teal",
  "sage",
  "rust",
  "plum",
  "slate",
];

const ANIMALS = [
  "lark",
  "panda",
  "otter",
  "fox",
  "owl",
  "tiger",
  "dolphin",
  "koala",
  "penguin",
  "rabbit",
  "eagle",
  "salmon",
  "turtle",
  "zebra",
  "falcon",
  "badger",
  "heron",
  "lynx",
  "crane",
  "finch",
  "lemur",
  "marmot",
  "osprey",
  "wombat",
  "quail",
];

function randomElement<T>(array: T[]): T {
  const index = Math.floor(Math.random() * array.length);
  return array[index]!;
}

function generatePlanName(): string {
  const adjective = randomElement(ADJECTIVES);
  const color = randomElement(COLORS);
  const animal = randomElement(ANIMALS);
  return `${adjective}-${color}-${animal}`;
}

const CONFIG_DIR = join(homedir(), ".config", "open-harness");
const PLANS_DIR = join(CONFIG_DIR, "plans");

// TODO: if anthropic bug still exists, add empty item here
const enterPlanModeInputSchema = z.object({});

export const enterPlanModeTool = () =>
  tool({
    needsApproval: false,
    description: `Enter plan mode to explore and design an implementation approach before making changes.

WHEN TO USE:
- Before starting non-trivial implementation tasks
- When you need to understand the codebase structure first
- When the user requests a plan or design before implementation
- When multiple approaches are possible and you need to explore options

WHAT HAPPENS:
- Tools are restricted to read-only operations (read, grep, glob, bash read-only commands)
- You can write ONLY to a plan file (stored in ~/.config/open-harness/plans/)
- You can delegate to explorer subagents only (not executor)
- System prompt is updated with plan mode instructions

HOW TO EXIT:
- Call exit_plan_mode when your plan is complete
- User will review and approve the plan before you can proceed with implementation`,
    inputSchema: enterPlanModeInputSchema,
    execute: async () => {
      // Ensure plans directory exists
      await mkdir(PLANS_DIR, { recursive: true });

      // Generate unique plan name
      const planName = generatePlanName();
      const planFilePath = join(PLANS_DIR, `${planName}.md`);

      return {
        success: true,
        message:
          "Entered plan mode. You can now explore the codebase and write your plan.",
        planFilePath,
        planName,
      };
    },
  });

// TODO: replace with AI SDK type helper to derive type from tool definition
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
