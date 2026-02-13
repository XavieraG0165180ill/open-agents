import { tool } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import * as path from "path";
import {
  isPathWithinDirectory,
  getSandbox,
  getApprovalContext,
  shouldAutoApprove,
} from "./utils";
import type { ApprovalRule } from "../types";
import type { Sandbox } from "@open-harness/sandbox";

const TIMEOUT_MS = 120_000;

const bashInputSchema = z.object({
  command: z.string().describe("The bash command to execute"),
  cwd: z
    .string()
    .optional()
    .describe("Working directory for the command (absolute path)"),
});

type BashInput = z.infer<typeof bashInputSchema>;
type ApprovalFn = (args: BashInput) => boolean | Promise<boolean>;

interface ToolOptions {
  needsApproval?: boolean | ApprovalFn;
}

/**
 * Check if the cwd parameter is outside the working directory.
 * If cwd is not provided, it defaults to working directory (no approval needed for path).
 */
function cwdIsOutsideWorkingDirectory(
  cwd: string | undefined,
  workingDirectory: string,
): boolean {
  if (!cwd) {
    return false;
  }
  const absoluteCwd = path.isAbsolute(cwd)
    ? cwd
    : path.resolve(workingDirectory, cwd);
  return !isPathWithinDirectory(absoluteCwd, workingDirectory);
}

/**
 * Check if a command matches any command-prefix approval rules.
 */
function commandMatchesApprovalRule(
  command: string,
  approvalRules: ApprovalRule[],
): boolean {
  const trimmedCommand = command.trim();
  for (const rule of approvalRules) {
    if (rule.type === "command-prefix" && rule.tool === "bash") {
      if (trimmedCommand.startsWith(rule.prefix)) {
        return true;
      }
    }
  }
  return false;
}

// Read-only commands that are safe to run without approval
const SAFE_COMMAND_PREFIXES = [
  "ls",
  "cat",
  "head",
  "tail",
  "find",
  "grep",
  "rg",
  "git status",
  "git log",
  "git diff",
  "git show",
  "git branch",
  "git remote",
  "pwd",
  "echo",
  "which",
  "type",
  "file",
  "wc",
  "tree",
];

// Commands that should always require approval
const DANGEROUS_COMMAND_PATTERNS = [
  /\brm\b/,
  /\bmv\b/,
  /\bcp\b/,
  /\bmkdir\b/,
  /\btouch\b/,
  /\bchmod\b/,
  /\bchown\b/,
  /\bsudo\b/,
  /\bgit\s+(push|commit|add|reset|checkout|merge|rebase|stash)/,
  /\bnpm\s+(install|uninstall|publish)/,
  /\bpnpm\s+(install|uninstall|publish)/,
  /\byarn\s+(add|remove|publish)/,
  /\bbun\s+(add|remove|install)/,
  /\bpip\s+install/,
  />/, // redirects
  /\|/, // pipes (could be dangerous)
  /&&/, // command chaining
  /;/, // command chaining
];

/**
 * Check if a command is safe to run without approval.
 * Returns true if approval is needed, false if safe.
 */
export function commandNeedsApproval(command: string): boolean {
  const trimmedCommand = command.trim();

  // Check for dangerous patterns first
  for (const pattern of DANGEROUS_COMMAND_PATTERNS) {
    if (pattern.test(trimmedCommand)) {
      return true;
    }
  }

  // Check if it starts with a safe command
  for (const prefix of SAFE_COMMAND_PREFIXES) {
    if (trimmedCommand.startsWith(prefix)) {
      return false;
    }
  }

  // Default to requiring approval for unknown commands
  return true;
}

// ---------------------------------------------------------------------------
// Shared execution logic
// ---------------------------------------------------------------------------

export interface BashExecResult {
  success: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated?: true;
}

/**
 * Execute a bash command via the sandbox.
 * Shared by both the custom bash tool and the Anthropic provider tool.
 */
export async function executeBash(
  sandbox: Sandbox,
  command: string,
  cwd?: string,
): Promise<BashExecResult> {
  const workingDirectory = sandbox.workingDirectory;

  const workingDir = cwd
    ? path.isAbsolute(cwd)
      ? cwd
      : path.resolve(workingDirectory, cwd)
    : workingDirectory;

  const result = await sandbox.exec(command, workingDir, TIMEOUT_MS);

  return {
    success: result.success,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    ...(result.truncated && { truncated: true }),
  };
}

// ---------------------------------------------------------------------------
// Shared approval logic
// ---------------------------------------------------------------------------

/**
 * Determine whether a bash invocation needs user approval.
 * Shared by both the custom bash tool and the Anthropic provider tool.
 */
export function bashNeedsApproval(
  args: { command: string; cwd?: string },
  experimental_context: unknown,
  options?: ToolOptions,
): boolean | PromiseLike<boolean> {
  const ctx = getApprovalContext(experimental_context, "bash");
  const { approval } = ctx;

  // Background and delegated modes auto-approve all operations
  if (shouldAutoApprove(approval)) {
    return false;
  }

  // Type guard narrowed approval to interactive mode
  // Check if command matches any saved session rules
  if (commandMatchesApprovalRule(args.command, approval.sessionRules)) {
    return false;
  }

  // Need approval if cwd is outside working directory
  if (cwdIsOutsideWorkingDirectory(args.cwd, ctx.workingDirectory)) {
    return true;
  }

  // Auto-approve all bash commands when autoApprove is "all"
  if (approval.autoApprove === "all") {
    return false;
  }

  // Check command safety
  if (commandNeedsApproval(args.command)) {
    // If command is dangerous, check user's approval setting
    if (typeof options?.needsApproval === "function") {
      return options.needsApproval(args);
    }
    return options?.needsApproval ?? true;
  }

  // Command is safe - no approval needed
  return false;
}

// ---------------------------------------------------------------------------
// Custom bash tool (used for non-Anthropic providers)
// ---------------------------------------------------------------------------

const BASH_DESCRIPTION = `Execute a bash command in the user's shell (non-interactive).

WHEN TO USE:
- Running existing project commands (build, test, lint, typecheck)
- Using read-only CLI tools (git status, git diff, ls, etc.)
- Invoking language/package managers (npm, pnpm, yarn, pip, go, etc.) as part of the task

WHEN NOT TO USE:
- Reading files (use readFileTool instead)
- Editing or creating files (use editFileTool or writeFileTool instead)
- Searching code or text (use grepTool and/or globTool instead)
- Interactive commands (shells, editors, REPLs) or long-lived daemons

USAGE:
- Runs bash -c "<command>" in a non-interactive shell (no TTY/PTY)
- Commands automatically timeout after ~2 minutes
- Combined stdout/stderr output is truncated after ~50,000 characters
- Use cwd to run in a specific directory; otherwise the current working directory is used

DO NOT USE FOR:
- File reading (cat, head, tail) - use readFileTool
- File editing (sed, awk, editors) - use editFileTool / writeFileTool
- File creation (touch, redirections like >, >>) - use writeFileTool
- Code search (grep, rg, ag) - use grepTool

IMPORTANT:
- Never chain commands with ';' or '&&' - use separate tool calls for each logical step
- Never use interactive commands (vim, nano, top, bash, ssh, etc.)
- Never start background processes with '&'
- Always quote file paths that may contain spaces
- Setting cwd to a path outside the working directory requires approval

EXAMPLES:
- Run the test suite: command: "npm test", cwd: "/Users/username/project"
- Check git status: command: "git status --short"
- List files in src: command: "ls -la", cwd: "/Users/username/project/src"`;

export const bashTool = (options?: ToolOptions) =>
  tool({
    needsApproval: (args, { experimental_context }) =>
      bashNeedsApproval(args, experimental_context, options),
    description: BASH_DESCRIPTION,
    inputSchema: bashInputSchema,
    execute: async ({ command, cwd }, { experimental_context }) => {
      const sandbox = getSandbox(experimental_context, "bash");
      return executeBash(sandbox, command, cwd);
    },
  });

// ---------------------------------------------------------------------------
// Anthropic provider bash tool (uses bash_20241022)
// ---------------------------------------------------------------------------

/**
 * Anthropic-native bash tool using the provider-defined `bash_20241022`.
 * Claude has been specifically trained on this tool interface.
 */
export const anthropicBashTool = (options?: ToolOptions) =>
  anthropic.tools.bash_20241022({
    needsApproval: (args, { experimental_context }) =>
      bashNeedsApproval(args, experimental_context, options),
    execute: async (args, { experimental_context }) => {
      const sandbox = getSandbox(experimental_context, "bash_anthropic");
      const result = await executeBash(sandbox, args.command);

      const parts: string[] = [];
      if (result.stdout) parts.push(result.stdout);
      if (result.stderr) parts.push(`[stderr]\n${result.stderr}`);
      if (parts.length === 0) parts.push(`(exit code ${result.exitCode})`);
      if (result.truncated) parts.push("[output truncated]");

      return [{ type: "text" as const, text: parts.join("\n") }];
    },
  });
