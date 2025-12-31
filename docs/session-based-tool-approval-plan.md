# Session-Based Tool Approval

This document outlines a feature to allow users to approve similar tool executions for the rest of a session, reducing repetitive approval prompts.

## Current State

The codebase has:

1. **`needsApproval: true`** on write, edit, and bash tools
2. **`autoAcceptMode`** state in ChatContext (`"off"` | `"edits"` | `"all"`)
3. Approval UI with Yes/No buttons via `addToolApprovalResponse`

The auto-accept logic isn't fully wired - the state exists but doesn't automatically approve matching tools based on patterns.

## Goal

Allow users to approve a tool execution and opt to "approve all similar" for the session. For example:

- Approve `bun test` once, then auto-approve `bun test:unit`, `bun test src/`
- Approve writes to `src/components/`, then auto-approve other writes in that directory

## Implementation Approach

### Option 1: Pattern-Based Session Approval

Track approved patterns in session state:

```typescript
// In chat-context.tsx
type ApprovedPattern = {
  toolName: string
  pattern: string // e.g., "bun test:*", "src/**/*.ts"
}

const [approvedPatterns, setApprovedPatterns] = useState<ApprovedPattern[]>([])
```

Then make `needsApproval` a function that checks against patterns:

```typescript
// In tool definition
needsApproval: ({ toolCallId, toolName, args }) => {
  // Check if this matches any approved pattern
  return !matchesApprovedPattern(args.command, approvedPatterns)
}
```

### Option 2: Command-Specific Approval

Track exact command prefixes that have been approved:

```typescript
// Track approved command prefixes
approvedCommands: Set<string> // e.g., {"bun test", "bun run typecheck"}
```

## UI Changes

1. Add a third option to approval buttons: **"Yes, and approve similar"**
2. Prompt user for what "similar" means (or infer it):
   - For bash: the command prefix (e.g., `bun test` from `bun test src/`)
   - For file writes: the directory or extension pattern

### Approval Button States

```
┌─────────────────────────────────────────┐
│ Run command: bun test src/utils         │
├─────────────────────────────────────────┤
│ [Yes]  [Yes, approve "bun test:*"]  [No]│
└─────────────────────────────────────────┘
```

## Files to Modify

| File | Changes |
|------|---------|
| `src/tui/chat-context.tsx` | Add `approvedPatterns` state and setter |
| `src/tui/components/tool-call.tsx` | Add "approve similar" button option |
| `src/agent/tools/context/bash.ts` | Make `needsApproval` a function |
| `src/agent/tools/context/write.ts` | Make `needsApproval` a function |
| `src/tui/transport.ts` | Pass approved patterns to agent |

## Architecture Challenge

The `needsApproval` function runs in the agent layer, but the approved patterns live in the TUI layer. Solutions:

1. **Pass patterns via agent options** - Include approved patterns in the options passed to `agent.stream()`
2. **Closure approach** - Create tools with a closure that captures the current patterns
3. **Shared state module** - A module that both layers can import

### Recommended: Pass via Agent Options

```typescript
// In transport.ts
const result = await agent.stream(modelMessages, {
  ...options,
  approvedPatterns: sessionApprovedPatterns,
})

// In tool definition
needsApproval: ({ args }, options) => {
  const patterns = options?.approvedPatterns ?? []
  return !matchesPattern(args.command, patterns)
}
```

## Pattern Matching Logic

### For Bash Commands

```typescript
function matchesBashPattern(command: string, pattern: string): boolean {
  // Pattern: "bun test:*" matches "bun test", "bun test:unit", "bun test src/"
  if (pattern.endsWith(':*')) {
    const prefix = pattern.slice(0, -2)
    return command.startsWith(prefix)
  }
  // Pattern: "bun *" matches any bun command
  if (pattern.endsWith(' *')) {
    const prefix = pattern.slice(0, -1)
    return command.startsWith(prefix)
  }
  return command === pattern
}
```

### For File Writes

```typescript
function matchesFilePattern(filePath: string, pattern: string): boolean {
  // Use minimatch or similar glob matching
  return minimatch(filePath, pattern)
}
```

## User Experience Flow

1. Tool requests approval (e.g., `bash: bun test src/utils`)
2. User sees three options:
   - **Yes** - Approve this one execution
   - **Yes, approve similar** - Approve and add pattern to session
   - **No** - Deny execution
3. If "approve similar" selected:
   - Show inferred pattern (e.g., `bun test:*`)
   - Allow user to edit pattern before confirming
4. Future matching commands auto-approve with a brief notification

## Session Indicator

Show active approval patterns in the UI:

```
Auto-approved: bun test:*, bun run typecheck:*, src/components/**
```

## Considerations

- **Security**: Patterns should be specific enough to avoid unintended approvals
- **Persistence**: Patterns reset on session end (intentional for security)
- **Visibility**: Show when a command was auto-approved vs manually approved
- **Escape hatch**: Allow users to clear all patterns mid-session
