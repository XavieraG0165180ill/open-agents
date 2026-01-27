"use client";

import type { ToolRendererProps } from "@/app/lib/render-tool";
import { ToolLayout } from "../tool-layout";

export function EnterPlanModeRenderer({
  part,
  state,
}: ToolRendererProps<"tool-enter_plan_mode">) {
  const outputText =
    part.state === "output-available"
      ? "Entered plan mode"
      : "Requesting plan mode";

  return (
    <ToolLayout
      name="Plan mode"
      summary="enter"
      state={state}
      output={outputText}
    />
  );
}
