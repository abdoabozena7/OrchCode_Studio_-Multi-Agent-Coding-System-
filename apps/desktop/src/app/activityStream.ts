import type {
  AgentRuntimeSession,
  RuntimeProgressEvent,
  RuntimeProgressStage,
  RuntimeProgressStatus,
  RuntimeTaskTransition
} from "@hivo/protocol";
import { buildReasoningTimeline, type ReasoningTimelineItem } from "./reasoningTimeline";

export type ActivityStreamStatus = "running" | "completed" | "blocked" | "failed";

export type ActivityStreamItem = {
  id: string;
  title: string;
  summary: string;
  status: ActivityStreamStatus;
  createdAt?: string;
  stage?: RuntimeProgressStage;
  targetFiles?: string[];
  agentName?: string;
  rationaleLabel?: string;
  nextLabel?: string;
  nextStepTitle?: string;
};

export type ActiveRuntimeCommand = {
  sessionId: string;
  requestId: string;
  command: string;
  cwd: string;
  autoRun: boolean;
};

export function buildPrimaryActivityItems(session: AgentRuntimeSession, activeCommand?: ActiveRuntimeCommand | null): ActivityStreamItem[] {
  const timeline = buildReasoningTimeline(session, activeCommand);
  const items = timeline.items.map((item) => toActivityStreamItem(item, session, timeline.nextStepTitle));
  if (items.length) return items;
  return session.taskState.transitions.map((transition) => ({
    id: transition.id,
    title: humanizeTransition(transition),
    summary: transition.detail,
    status: mapTransitionStatus(transition),
    createdAt: transition.createdAt,
    rationaleLabel: reasonLabelForSession(session),
    nextLabel: nextLabelForSession(session)
  }));
}

export function describeCurrentStep(
  session: AgentRuntimeSession,
  connectionState: "connected" | "disconnected",
  activeCommand?: ActiveRuntimeCommand | null
): ActivityStreamItem {
  if (connectionState === "disconnected" && session.status === "running") {
    return {
      id: "current-disconnected",
      title: "Live updates disconnected",
      summary: "The run may still be active, but the live event stream is disconnected.",
      status: "blocked"
    };
  }

  if (!["completed", "blocked", "failed", "failed_provider", "needs_approval", "expired"].includes(session.status)) {
    const timeline = buildReasoningTimeline(session, activeCommand);
    if (timeline.current) {
      return toActivityStreamItem(timeline.current, session, timeline.nextStepTitle);
    }
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

  if (session.status === "needs_approval") {
    return {
      id: "current-needs-approval",
      title: "Review required",
      summary: session.nextAction?.message ?? session.runSummary?.summary ?? "The run is waiting for operator review.",
      status: "blocked"
    };
  }

  if (session.status === "expired") {
    return {
      id: "current-expired",
      title: "Session expired",
      summary: session.taskState.restoreState?.reason ?? "The runtime session token expired.",
      status: "failed"
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
      /Provider patch output was invalid; (?:no deterministic implementation was invented|using only the explicit file path and content from the user request)\./i.test(entry)
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

  if (session.status === "failed_provider") {
    return {
      id: "current-provider-failed",
      title: "Provider failed",
      summary: session.providerTelemetry?.lastError ?? session.runSummary?.summary ?? "The real provider failed or was unavailable.",
      status: "failed"
    };
  }

  if (session.status === "running" && !session.progressEvents.length) {
    const model = session.providerConfig?.selectedModel ?? session.providerConfig?.routerModel ?? "the selected model";
    return {
      id: "current-waiting-provider",
      title: isArabicSession(session) ? "بانتظار رد الموديل" : "Waiting for provider",
      summary: isArabicSession(session)
        ? `الموديل ${model} بيجهز أول خطوة.`
        : `${model} is preparing the first step.`,
      status: "running"
    };
  }

  const latest = buildPrimaryActivityItems(session, activeCommand).at(-1);
  return {
    id: "current-working",
    title: latest?.title ?? "Starting local run",
    summary: latest?.summary ?? "Starting local run...",
    status: latest?.status ?? "running"
  };
}

export function describeNextProgressStep(session: AgentRuntimeSession, item: ActivityStreamItem): string | undefined {
  return item.nextStepTitle ?? nextKnownStepTitle(session, item.title);
}

function toActivityStreamItem(item: ReasoningTimelineItem, session: AgentRuntimeSession, nextStepTitle?: string): ActivityStreamItem {
  return {
    id: item.id,
    title: item.title,
    summary: item.summary,
    status: item.status === "idle" || item.status === "queued" ? "running" : item.status,
    createdAt: item.createdAt,
    targetFiles: item.targetFiles,
    rationaleLabel: item.rationale ? reasonLabelForSession(session) : undefined,
    nextLabel: nextLabelForSession(session),
    nextStepTitle,
    agentName: item.subtitle
  };
}

function mapProgressEventToActivityItem(event: RuntimeProgressEvent): ActivityStreamItem {
  return {
    id: event.id,
    title: event.taskTitle ?? humanizeProgressStage(event.stage),
    summary: event.summary,
    status: mapProgressStatus(event.status),
    createdAt: event.createdAt,
    stage: event.stage,
    targetFiles: event.targetFiles,
    agentName: event.agentName
  };
}

function annotateProgressItems(items: ActivityStreamItem[], session: AgentRuntimeSession) {
  return items.map((item) => ({
    ...item,
    rationaleLabel: reasonLabelForSession(session),
    nextLabel: nextLabelForSession(session),
    nextStepTitle: nextKnownStepTitle(session, item.title)
  }));
}

function annotateCurrentItem(item: ActivityStreamItem, session: AgentRuntimeSession, events: RuntimeProgressEvent[]) {
  const nextEvent = events.find((event) => event.createdAt > (item.createdAt ?? "") && event.status !== "completed");
  return {
    ...item,
    rationaleLabel: reasonLabelForSession(session),
    nextLabel: nextLabelForSession(session),
    nextStepTitle: nextEvent?.taskTitle ?? nextKnownStepTitle(session, item.title)
  };
}

function selectCurrentProgressEvent(events: RuntimeProgressEvent[]) {
  return events.at(-1);
}

function nextKnownStepTitle(session: AgentRuntimeSession, title: string) {
  const steps = isArabicSession(session)
    ? ["فهم الطلب", "قراءة المشروع", "تحديد نوع السؤال", "تقرير الأدلة", "فتح الملفات", "مراجعة الأدلة", "تجهيز الرد", "حفظ النتيجة"]
    : ["Intake", "Workspace snapshot", "Question mode", "Evidence report", "Workspace reading", "Evidence validation", "Answer drafting", "Final report"];
  const index = steps.indexOf(title);
  return index >= 0 ? steps[index + 1] : undefined;
}

function reasonLabelForSession(session: AgentRuntimeSession) {
  return isArabicSession(session) ? "ليه الخطوة دي" : "Why this step";
}

function nextLabelForSession(session: AgentRuntimeSession) {
  return isArabicSession(session) ? "التالي" : "Next";
}

function isArabicSession(session: AgentRuntimeSession) {
  return /[\u0600-\u06ff]/.test(session.userPrompt);
}

function humanizeProgressStage(stage: RuntimeProgressStage) {
  return stage
    .replaceAll("_", " ")
    .replace(/\b\w/g, (value) => value.toUpperCase());
}

function mapProgressStatus(status: RuntimeProgressStatus): ActivityStreamStatus {
  if (status === "blocked") return "blocked";
  if (status === "failed") return "failed";
  if (status === "completed") return "completed";
  return "running";
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
