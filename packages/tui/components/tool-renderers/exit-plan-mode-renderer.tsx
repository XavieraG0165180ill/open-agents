import React from "react";
import { Box, Text } from "ink";
import type { ToolRendererProps } from "../../lib/render-tool";
import { ToolSpinner, getDotColor } from "./shared";

export function ExitPlanModeRenderer({
  part,
  state,
}: ToolRendererProps<"tool-exit_plan_mode">) {
  const isStreaming = part.state === "input-streaming";
  const dotColor = getDotColor(state);

  return (
    <Box flexDirection="column" marginTop={1} marginBottom={1}>
      <Box>
        {isStreaming ? <ToolSpinner /> : <Text color={dotColor}>● </Text>}
        <Text bold color={state.denied ? "red" : "white"}>
          Plan complete. Requesting approval to proceed.
        </Text>
      </Box>

      {state.denied && (
        <Box paddingLeft={2}>
          <Text color="gray">└ </Text>
          <Text color="red">
            Denied{state.denialReason ? `: ${state.denialReason}` : ""}
          </Text>
        </Box>
      )}
    </Box>
  );
}
