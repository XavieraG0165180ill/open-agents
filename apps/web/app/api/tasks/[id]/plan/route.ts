import { join, isAbsolute, resolve, sep } from "node:path";
import { connectSandbox } from "@open-harness/sandbox";
import { generatePlanName } from "@open-harness/shared";
import { getTaskById } from "@/lib/db/tasks";
import { isSandboxActive } from "@/lib/sandbox/utils";
import { getServerSession } from "@/lib/session/get-server-session";

type RouteContext = {
  params: Promise<{ id: string }>;
};

type PlanResponse = {
  plan: string | null;
  planFilePath: string;
};

const PLAN_DIR_PARTS = [".open-harness", "plans"] as const;

function resolvePlanPath(workingDirectory: string, planFilePath: string) {
  const absolutePath = isAbsolute(planFilePath)
    ? planFilePath
    : resolve(workingDirectory, planFilePath);
  const plansDir = resolve(workingDirectory, ...PLAN_DIR_PARTS);
  const plansPrefix = plansDir.endsWith(sep) ? plansDir : `${plansDir}${sep}`;

  if (!absolutePath.startsWith(plansPrefix)) {
    return null;
  }
  if (!absolutePath.endsWith(".md")) {
    return null;
  }
  return absolutePath;
}

export async function GET(req: Request, context: RouteContext) {
  const session = await getServerSession();
  if (!session?.user) {
    return Response.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { id: taskId } = await context.params;
  const url = new URL(req.url);
  const planFilePath = url.searchParams.get("path");

  if (!planFilePath) {
    return Response.json({ error: "path is required" }, { status: 400 });
  }

  const task = await getTaskById(taskId);
  if (!task) {
    return Response.json({ error: "Task not found" }, { status: 404 });
  }
  if (task.userId !== session.user.id) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!isSandboxActive(task.sandboxState)) {
    return Response.json({ error: "Sandbox not initialized" }, { status: 400 });
  }

  try {
    const sandbox = await connectSandbox(task.sandboxState);
    const resolvedPlanPath = resolvePlanPath(
      sandbox.workingDirectory,
      planFilePath,
    );
    if (!resolvedPlanPath) {
      return Response.json({ error: "Invalid plan path" }, { status: 400 });
    }

    try {
      const plan = await sandbox.readFile(resolvedPlanPath, "utf-8");
      const response: PlanResponse = {
        plan,
        planFilePath: resolvedPlanPath,
      };
      return Response.json(response);
    } catch {
      const response: PlanResponse = {
        plan: null,
        planFilePath: resolvedPlanPath,
      };
      return Response.json(response);
    }
  } catch (error) {
    console.error("Failed to load plan file:", error);
    return Response.json(
      { error: "Failed to connect to sandbox" },
      { status: 500 },
    );
  }
}

export async function POST(_req: Request, context: RouteContext) {
  const session = await getServerSession();
  if (!session?.user) {
    return Response.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { id: taskId } = await context.params;

  const task = await getTaskById(taskId);
  if (!task) {
    return Response.json({ error: "Task not found" }, { status: 404 });
  }
  if (task.userId !== session.user.id) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!isSandboxActive(task.sandboxState)) {
    return Response.json({ error: "Sandbox not initialized" }, { status: 400 });
  }

  try {
    const sandbox = await connectSandbox(task.sandboxState);
    const plansDir = resolve(sandbox.workingDirectory, ...PLAN_DIR_PARTS);
    await sandbox.mkdir(plansDir, { recursive: true });

    const planName = generatePlanName();
    const planFilePath = join(plansDir, `${planName}.md`);

    return Response.json({
      planFilePath,
      planName,
    });
  } catch (error) {
    console.error("Failed to initialize plan file:", error);
    return Response.json(
      { error: "Failed to create plan file" },
      { status: 500 },
    );
  }
}
