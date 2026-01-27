"use client";

import type { ToolRendererProps } from "@/app/lib/render-tool";
import { ToolLayout } from "../tool-layout";

export function ExitPlanModeRenderer({
  part,
  state,
}: ToolRendererProps<"tool-exit_plan_mode">) {
  const isCompleted =
    part.state === "output-available" &&
    typeof part.output === "object" &&
    part.output !== null &&
    "success" in part.output &&
    part.output.success === true;

  const hasPlan =
    isCompleted &&
    "plan" in part.output &&
    typeof part.output.plan === "string" &&
    part.output.plan.trim().length > 0;

  let outputText = "Plan complete. Awaiting approval.";
  if (state.denied) {
    outputText = "Plan rejected";
  } else if (isCompleted) {
    outputText = hasPlan ? "Plan approved" : "Exited plan mode";
  }

  return (
    <ToolLayout
      name="Plan mode"
      summary="exit"
      state={state}
      output={outputText}
    />
  );
}
