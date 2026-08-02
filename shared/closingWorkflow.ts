export type ClosingStatus = "draft" | "pending_approval" | "approved" | "locked";
export type ClosingAction = "submit" | "refresh" | "approve" | "add_adjustment" | "lock";

export function nextClosingStatus(params: {
  status: ClosingStatus;
  action: ClosingAction;
  isStale?: boolean;
  hasUnapprovedAdjustments?: boolean;
}): ClosingStatus {
  const { status, action, isStale = false, hasUnapprovedAdjustments = false } = params;
  if (action === "refresh" && (status === "draft" || status === "pending_approval")) return "draft";
  if (action === "submit" && status === "draft") return "pending_approval";
  if (action === "approve" && status === "pending_approval") {
    if (isStale) throw new Error("Cannot approve a stale closing snapshot");
    return "approved";
  }
  if (action === "add_adjustment" && status === "approved") return "pending_approval";
  if (action === "lock" && status === "approved") {
    if (hasUnapprovedAdjustments) throw new Error("Closing has adjustments awaiting re-approval");
    return "locked";
  }
  throw new Error(`Invalid closing transition: ${status} -> ${action}`);
}

export function assertContinuousPeriod(previousTo: Date | null, nextFrom: Date): void {
  if (previousTo && previousTo.getTime() !== nextFrom.getTime()) {
    throw new Error("Closing periods must be continuous and non-overlapping");
  }
}
