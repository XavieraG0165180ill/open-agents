"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

type PlanApprovalPanelProps = {
  taskId: string;
  approvalId: string;
  planFilePath: string;
  onApprove: (id: string) => void;
  onDeny: (id: string, reason?: string) => void;
};

export function PlanApprovalPanel({
  taskId,
  approvalId,
  planFilePath,
  onApprove,
  onDeny,
}: PlanApprovalPanelProps) {
  const [plan, setPlan] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState("");

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    setPlan(null);

    const loadPlan = async () => {
      try {
        const response = await fetch(
          `/api/tasks/${taskId}/plan?path=${encodeURIComponent(planFilePath)}`,
        );
        if (!response.ok) {
          const data = (await response.json()) as { error?: string };
          throw new Error(data.error ?? "Failed to load plan");
        }
        const data = (await response.json()) as {
          plan: string | null;
          planFilePath: string;
        };
        if (!cancelled) {
          setPlan(data.plan);
        }
      } catch (err) {
        if (!cancelled) {
          const message = err instanceof Error ? err.message : String(err);
          setError(message);
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    };

    void loadPlan();

    return () => {
      cancelled = true;
    };
  }, [planFilePath, taskId]);

  const handleApprove = () => {
    onApprove(approvalId);
  };

  const handleDeny = () => {
    const reason = feedback.trim();
    onDeny(approvalId, reason.length > 0 ? reason : undefined);
  };

  return (
    <div className="rounded-2xl border border-border bg-card p-4 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-foreground">Plan ready</p>
          <p className="text-xs text-muted-foreground">
            Review the plan and approve to start implementation.
          </p>
        </div>
        <span className="text-xs text-muted-foreground">
          {planFilePath}
        </span>
      </div>

      <div
        className={cn(
          "mt-3 max-h-64 overflow-auto rounded-lg border border-border bg-muted/40 p-3 text-sm",
          !plan && !isLoading && "text-muted-foreground",
        )}
      >
        {isLoading && "Loading plan..."}
        {!isLoading && error && `Failed to load plan: ${error}`}
        {!isLoading && !error && (plan?.trim() ? plan : "(No plan content)")}
      </div>

      <div className="mt-3">
        <label
          htmlFor="plan-feedback"
          className="text-xs font-medium text-muted-foreground"
        >
          Feedback (optional)
        </label>
        <Textarea
          id="plan-feedback"
          value={feedback}
          onChange={(e) => setFeedback(e.currentTarget.value)}
          placeholder="Tell the agent what to change in the plan"
          className="mt-2 min-h-[80px]"
        />
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          className="bg-emerald-600 text-white hover:bg-emerald-600/90"
          onClick={handleApprove}
        >
          Approve plan
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="border-red-600 text-red-600 hover:bg-red-600 hover:text-white"
          onClick={handleDeny}
        >
          Request changes
        </Button>
      </div>
    </div>
  );
}
