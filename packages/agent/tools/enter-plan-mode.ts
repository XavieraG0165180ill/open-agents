import { tool } from "ai";
import { z } from "zod";
import { join } from "node:path";
import {
  generatePlanName,
  type EnterPlanModeOutput,
  isEnterPlanModeOutput,
  extractEnterPlanModeOutput,
} from "@open-harness/shared";
import { getAgentContext } from "./utils";

// Re-export from shared for backwards compatibility
export {
  type EnterPlanModeOutput,
  isEnterPlanModeOutput,
  extractEnterPlanModeOutput,
};

const enterPlanModeInputSchema = z.object({
  // This input schema is here to stop anthropic streaming bug
  _: z.string().describe("Pass an empty string"),
});

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
- You can write ONLY to a plan file (stored in {project}/.open-harness/plans/)
- You can delegate to explorer subagents only (not executor)
- System prompt is updated with plan mode instructions

HOW TO EXIT:
- Call exit_plan_mode when your plan is complete
- User will review and approve the plan before you can proceed with implementation`,
    inputSchema: enterPlanModeInputSchema,
    execute: async (_, { experimental_context }) => {
      const { sandbox } = getAgentContext(
        experimental_context,
        "enter_plan_mode",
      );

      // Create plan file in project directory
      const planName = generatePlanName();
      const plansDir = join(sandbox.workingDirectory, ".open-harness", "plans");
      await sandbox.mkdir(plansDir, { recursive: true });
      const planFilePath = join(plansDir, `${planName}.md`);

      return {
        success: true,
        message:
          "Entered plan mode. You can now explore the codebase and write your plan.",
        planFilePath,
        planName,
      };
    },
  });
