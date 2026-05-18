import type { AgentRuntimeSession, RuntimeTaskTransition } from "@orchcode/protocol";

export type ActivityStreamStatus = "running" | "completed" | "blocked" | "failed";

export type ActivityStreamItem = {
  id: string;
  title: string;
  summary: string;
  status: ActivityStreamStatus;
  createdAt?: string;
};

export type ActiveRuntimeCommand = {
  sessionId: string;
  requestId: string;
  command: string;
  cwd: string;
  autoRun: boolean;
};

export function buildPrimaryActivityItems(session: AgentRuntimeSession, activeCommand?: ActiveRuntimeCommand | null): ActivityStreamItem[] {
  const items: ActivityStreamItem[] = session.taskState.transitions
    .slice(-8)
    .map((transition) => ({
      id: transition.id,
      title: humanizeTransition(transition),
      summary: transition.detail,
      status: mapTransitionStatus(transition),
      createdAt: transition.createdAt
    }));

  if (activeCommand && activeCommand.sessionId === session.id) {
    items.push({
      id: `local-command-${activeCommand.requestId}`,
      title: "Command Started",
      summary: `Running command: ${activeCommand.command} in ${activeCommand.cwd}`,
      status: "running"
    });
  }

  const fallbackNote = session.reasoningSummaries.find((entry) =>
    /deterministic fallback plan was used/i.test(entry)
  );
  if (fallbackNote) {
    items.push({
      id: "provider-fallback",
      title: "Provider fallback",
      summary: fallbackNote,
      status: "completed"
    });
  }

  const implementationFallbackNote = session.reasoningSummaries.find((entry) =>
    /Provider patch output was invalid; using deterministic implementation fallback\./i.test(entry)
  );
  if (implementationFallbackNote) {
    items.push({
      id: "implementation-fallback",
      title: "Implementation fallback",
      summary: implementationFallbackNote,
      status: "completed"
    });
  }

  return items;
}

export function describeCurrentStep(
  session: AgentRuntimeSession,
  connectionState: "connected" | "disconnected",
  activeCommand?: ActiveRuntimeCommand | null
): ActivityStreamItem {
  if (activeCommand && activeCommand.sessionId === session.id) {
    return {
      id: `current-running-${activeCommand.requestId}`,
      title: `Running command: ${activeCommand.command}`,
      summary: `${activeCommand.autoRun ? "Policy-classified auto-run" : "Approved run"} in ${activeCommand.cwd}`,
      status: "running"
    };
  }

  if (connectionState === "disconnected" && session.status === "running") {
    return {
      id: "current-disconnected",
      title: "Live updates disconnected",
      summary: "The run may still be active, but the live event stream is disconnected.",
      status: "blocked"
    };
  }

  if (session.nextAction?.kind === "preview_ready") {
    return {
      id: "current-preview-ready",
      title: "Preview available",
      summary: session.nextAction.message,
      status: "completed"
    };
  }

  if (session.nextAction?.kind === "confirm_plan") {
    return {
      id: "current-plan-review",
      title: "Plan review required",
      summary: session.nextAction.message,
      status: "running"
    };
  }

  if (session.nextAction?.kind === "approve_commands") {
    return {
      id: "current-command-ready",
      title: "Command ready",
      summary: session.nextAction.message,
      status: "running"
    };
  }

  if (session.commandExecutions.at(-1)?.status === "failed") {
    return {
      id: "current-command-failed",
      title: "Command failed",
      summary: session.commandExecutions.at(-1)?.message ?? "The latest command failed.",
      status: "failed"
    };
  }

  if (session.status === "completed") {
    return {
      id: "current-complete",
      title: "Run complete",
      summary: session.runSummary?.summary ?? "The run completed successfully.",
      status: "completed"
    };
  }

  if (session.status === "blocked" || session.lifecycleStage === "BLOCKED") {
    return {
      id: "current-attention",
      title: "Needs attention",
      summary: session.runSummary?.summary ?? session.runToGreen?.blockerReason ?? "The run needs attention before it can continue.",
      status: "blocked"
    };
  }

  if (session.status === "failed") {
    const implementationFallbackNote = session.reasoningSummaries.find((entry) =>
      /Provider patch output was invalid; using deterministic implementation fallback\./i.test(entry)
    );
    if (implementationFallbackNote) {
      return {
        id: "current-fallback-review",
        title: "Needs review",
        summary: implementationFallbackNote,
        status: "running"
      };
    }
    return {
      id: "current-failed",
      title: "Run failed",
      summary: session.runSummary?.summary ?? "The run failed.",
      status: "failed"
    };
  }

  const latest = buildPrimaryActivityItems(session, activeCommand).at(-1);
  return {
    id: "current-working",
    title: latest?.title ?? "Working",
    summary: latest?.summary ?? "Preparing the project flow.",
    status: latest?.status ?? "running"
  };
}

function humanizeTransition(transition: RuntimeTaskTransition) {
  if (/blocked/i.test(transition.type)) {
    return "Needs Attention";
  }
  return transition.type
    .replaceAll(".", " ")
    .replace(/\b\w/g, (value) => value.toUpperCase());
}

function mapTransitionStatus(transition: RuntimeTaskTransition): ActivityStreamStatus {
  if (/(failed|expired)/i.test(transition.type)) return "failed";
  if (/(blocked|rejected)/i.test(transition.type)) return "blocked";
  if (/(completed|passed|approved|applied|requested|started|pending|updated|created|restored)/i.test(transition.type)) {
    return transition.type === "command.requested" || transition.type === "verification.pending"
      ? "running"
      : "completed";
  }
  return "running";
}
