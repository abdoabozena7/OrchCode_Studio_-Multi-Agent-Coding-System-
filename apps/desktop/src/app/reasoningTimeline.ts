import type {
  AgentRuntimeSession,
  AgentRuntimeSwarmNode,
  RuntimeProgressEvent,
  RuntimeProgressStage,
  RuntimeProgressStatus
} from "@hivo/protocol";

export type ReasoningTimelineStatus = "idle" | "queued" | "running" | "completed" | "blocked" | "failed";

export type ReasoningTimelineKind =
  | "understanding"
  | "reasoning"
  | "tool"
  | "evidence"
  | "verification"
  | "adjustment"
  | "activity"
  | "result"
  | "swarm";

export type ReasoningTimelineItem = {
  id: string;
  kind: ReasoningTimelineKind;
  title: string;
  subtitle?: string;
  summary: string;
  status: ReasoningTimelineStatus;
  createdAt?: string;
  rationale?: string;
  facts: string[];
  targetFiles: string[];
  thoughtCount: number;
  fileCount: number;
  commandCount: number;
  children: ReasoningTimelineItem[];
};

export type ReasoningTimeline = {
  title: string;
  subtitle: string;
  items: ReasoningTimelineItem[];
  current: ReasoningTimelineItem;
  nextStepTitle?: string;
  active: boolean;
  startedAt?: string;
};

type TimelineLabels = {
  title: string;
  subtitle: string;
  understanding: string;
  step: (index: number) => string;
  tool: string;
  files: string;
  command: string;
  evidence: string;
  verification: string;
  adjustment: string;
  final: string;
  next: string;
  waiting: string;
  working: string;
  complete: string;
};

export function buildReasoningTimeline(
  session: AgentRuntimeSession,
  activeCommand?: { sessionId: string; requestId: string; command: string; cwd: string; autoRun: boolean } | null
): ReasoningTimeline {
  const labels = labelsForSession(session);
  const progressItems = session.progressEvents.map((event) => progressItem(event, labels));
  const trace = session.latestDecisionPipeline?.reasoningTrace;
  const initialStep = session.latestDecisionPipeline?.reasoningInitialStep;
  const items: ReasoningTimelineItem[] = [...progressItems];

  if (trace?.understanding || session.latestDecisionPipeline?.turnUnderstanding || initialStep) {
    items.push(buildUnderstandingItem(session, labels, trace?.understanding ?? session.latestDecisionPipeline?.turnUnderstanding));
  }

  if (initialStep && !trace?.steps?.some((step) => step.id === initialStep.id)) {
    items.push(buildReasoningStepItem(initialStep, 0, session, labels));
  }

  if (trace?.steps?.length) {
    trace.steps.forEach((step, index) => {
      items.push(buildReasoningStepItem(step, index, session, labels));
    });
  }

  if (trace?.toolResults?.length) {
    trace.toolResults.forEach((result) => {
      items.push(buildToolResultItem(result, labels));
    });
  }

  if (trace?.progress?.length) {
    trace.progress.forEach((progress) => {
      const fileCount = progress.newFileCount;
      const evidenceCount = progress.newEvidenceCount;
      items.push(makeItem({
        id: `reasoning:progress:${progress.round}:${progress.createdAt}`,
        kind: "evidence",
        title: labels.evidence,
        subtitle: `Round ${progress.round}`,
        summary: progress.reason,
        status: progress.stagnant ? "blocked" : "completed",
        createdAt: progress.createdAt,
        facts: [
          evidenceCount ? `${evidenceCount} evidence` : "No new evidence",
          fileCount ? `${fileCount} file${fileCount === 1 ? "" : "s"}` : "",
          progress.newRelationshipCount ? `${progress.newRelationshipCount} relationship${progress.newRelationshipCount === 1 ? "" : "s"}` : "",
          `Information gain ${progress.informationGain}`
        ]
      }));
    });
  }

  if (trace?.repairErrors?.length) {
    trace.repairErrors.forEach((error) => {
      items.push(makeItem({
        id: `reasoning:adjustment:${error.createdAt}:${error.kind}`,
        kind: "adjustment",
        title: labels.adjustment,
        subtitle: error.stage,
        summary: error.message,
        status: session.status === "running" ? "running" : "completed",
        createdAt: error.createdAt,
        facts: [error.kind.replaceAll("_", " ")]
      }));
    });
  }

  if (trace?.verificationResults?.length) {
    trace.verificationResults.forEach((verification, index) => {
      items.push(makeItem({
        id: `reasoning:verification:${index}:${verification.createdAt}`,
        kind: "verification",
        title: labels.verification,
        subtitle: verification.verdict.replaceAll("_", " "),
        summary: verification.rationale,
        status: verification.verdict === "pass" ? "completed" : verification.verdict === "needs_more_evidence" ? "blocked" : "failed",
        createdAt: verification.createdAt,
        facts: [
          verification.supportedClaims.length ? `${verification.supportedClaims.length} supported claim${verification.supportedClaims.length === 1 ? "" : "s"}` : "",
          verification.unsupportedClaims.length ? `${verification.unsupportedClaims.length} unsupported claim${verification.unsupportedClaims.length === 1 ? "" : "s"}` : "",
          verification.missingFacts.length ? `${verification.missingFacts.length} missing fact${verification.missingFacts.length === 1 ? "" : "s"}` : ""
        ]
      }));
    });
  }

  const activityProjection = getRunActivityProjection(session);
  if (activityProjection?.durableRows.length) {
    activityProjection.durableRows.slice(-24).forEach((row) => {
      items.push(makeItem({
        id: `activity:${row.id}`,
        kind: row.kind === "command" ? "tool" : row.kind === "validation" ? "verification" : "activity",
        title: row.title,
        subtitle: row.kind.replaceAll("_", " "),
        summary: row.summary,
        status: row.status,
        createdAt: row.createdAt,
        facts: row.nodeId ? [`Node ${row.nodeId}`] : [],
        commandCount: row.kind === "command" ? 1 : 0,
        thoughtCount: row.kind === "thought" || row.kind === "split" ? 1 : 0
      }));
    });
  }

  const swarmTree = buildSwarmTreeItem(session, labels);
  if (swarmTree) items.push(swarmTree);

  progressItems.forEach((item) => {
    if (!items.some((existing) => equivalentTimelineItem(existing, item))) items.push(item);
  });

  if (activeCommand?.sessionId === session.id) {
    items.push(makeItem({
      id: `local-command-${activeCommand.requestId}`,
      kind: "tool",
      title: labels.command,
      summary: `Running command: ${activeCommand.command} in ${activeCommand.cwd}`,
      status: "running",
      facts: [activeCommand.autoRun ? "Policy-classified auto-run" : "Approved run"],
      commandCount: 1
    }));
  }

  const fallbackNote = session.reasoningSummaries.find((entry) => /deterministic fallback plan was used/i.test(entry));
  if (fallbackNote) {
    items.push(makeItem({
      id: "provider-fallback",
      kind: "adjustment",
      title: labels.adjustment,
      summary: fallbackNote,
      status: "completed"
    }));
  }

  const outcome = session.latestDecisionPipeline?.outcome;
  const resultSummary = outcome?.reason ?? (session.status === "completed" ? session.runSummary?.summary : undefined);
  if (resultSummary) {
    items.push(makeItem({
      id: "reasoning:result",
      kind: "result",
      title: labels.final,
      summary: resultSummary,
      status: session.status === "completed" ? "completed" : mapSessionStatus(session.status)
    }));
  }

  const dedupedItems = dedupeTimelineItems(items);
  const active = isSessionActive(session) || dedupedItems.some((item) => item.status === "running" || item.status === "queued");
  const current = selectCurrentItem(session, dedupedItems, labels);
  const nextStepTitle = nextStepFor(session, current.title, labels);

  return {
    title: labels.title,
    subtitle: labels.subtitle,
    items: dedupedItems.slice(-32),
    current,
    nextStepTitle,
    active,
    startedAt: latestUserMessageCreatedAt(session) ?? trace?.startedAt
  };
}

export function isArabicReasoningSession(session: AgentRuntimeSession) {
  return /[\u0600-\u06ff]/.test(session.userPrompt);
}

function buildUnderstandingItem(
  session: AgentRuntimeSession,
  labels: TimelineLabels,
  understanding?: NonNullable<NonNullable<AgentRuntimeSession["latestDecisionPipeline"]>["turnUnderstanding"]>
): ReasoningTimelineItem {
  const route = understanding?.route ?? session.latestDecisionPipeline?.query.route;
  const summary = understanding?.rationale
    ?? session.progressEvents.find((event) => /understanding request|فهم الطلب/i.test(event.taskTitle ?? ""))?.summary
    ?? labels.waiting;
  return makeItem({
    id: `reasoning:understanding:${session.latestDecisionPipeline?.id ?? session.id}`,
    kind: "understanding",
    title: labels.understanding,
    subtitle: ["provider", route, understanding?.risk].filter(Boolean).join(" | "),
    summary,
    status: session.latestDecisionPipeline?.stages.find((stage) => stage.stage === "route")?.status === "completed"
      ? "completed"
      : isSessionActive(session) ? "running" : "completed",
    rationale: understanding?.rationale,
    facts: [
      understanding?.goal ? `Goal: ${understanding.goal}` : "",
      route ? `Route: ${route}` : "",
      understanding?.confidence ? `Confidence: ${understanding.confidence}` : ""
    ]
  });
}

function buildReasoningStepItem(
  step: NonNullable<NonNullable<AgentRuntimeSession["latestDecisionPipeline"]>["reasoningInitialStep"]>,
  index: number,
  session: AgentRuntimeSession,
  labels: TimelineLabels
): ReasoningTimelineItem {
  const toolKinds = [...new Set(step.toolRequests.map((request) => request.kind))];
  const facts = [
    toolKinds.length ? `${step.toolRequests.length} tool request${step.toolRequests.length === 1 ? "" : "s"}: ${toolKinds.join(", ")}` : "",
    step.expectedInformationGain ? `Expected gain: ${step.expectedInformationGain}` : "",
    step.targetUnknowns?.length ? `${step.targetUnknowns.length} target unknown${step.targetUnknowns.length === 1 ? "" : "s"}` : ""
  ];
  return makeItem({
    id: `reasoning:step:${step.id}`,
    kind: "reasoning",
    title: labels.step(index + 1),
    subtitle: step.kind.replaceAll("_", " "),
    summary: step.rationale || labels.working,
    status: session.status === "running" && index === 0 && !session.latestDecisionPipeline?.reasoningTrace ? "running" : "completed",
    rationale: step.rationale,
    facts
  });
}

function buildToolResultItem(
  result: NonNullable<NonNullable<AgentRuntimeSession["latestDecisionPipeline"]>["reasoningTrace"]>["toolResults"][number],
  labels: TimelineLabels
): ReasoningTimelineItem {
  const evidencePaths = unique(result.evidenceRefs.map((ref) => ref.path).filter((path): path is string => Boolean(path)));
  const isCommand = result.kind === "run_command";
  const isFile = ["list_files", "repository_search", "read_file", "inspect_manifest", "investigate_project", "semantic_search", "follow_relationships", "read_semantic_sources"].includes(result.kind);
  return makeItem({
    id: `reasoning:tool:${result.requestId}`,
    kind: isFile ? "evidence" : "tool",
    title: isCommand ? labels.command : isFile ? labels.files : labels.tool,
    subtitle: result.kind.replaceAll("_", " "),
    summary: result.summary,
    status: mapToolStatus(result.status),
    createdAt: result.createdAt,
    facts: [
      evidencePaths.length ? `${evidencePaths.length} file${evidencePaths.length === 1 ? "" : "s"}: ${evidencePaths.slice(0, 4).join(", ")}` : "",
      result.status.replaceAll("_", " ")
    ],
    targetFiles: evidencePaths,
    fileCount: evidencePaths.length,
    commandCount: isCommand ? 1 : 0
  });
}

function buildSwarmTreeItem(session: AgentRuntimeSession, labels: TimelineLabels): ReasoningTimelineItem | null {
  const tree = session.recursiveSwarmRunState?.tree;
  const swarm = session.swarmState;
  const nodes = tree?.nodes?.length ? tree.nodes : swarm?.nodes ?? [];
  if (!nodes.length) return null;
  const byParent = new Map<string, AgentRuntimeSwarmNode[]>();
  const byId = new Map(nodes.map((node) => [node.id, node]));
  for (const node of nodes) {
    if (!node.parentId) continue;
    const children = byParent.get(node.parentId) ?? [];
    children.push(node);
    byParent.set(node.parentId, children);
  }
  const rootId = tree?.rootId ?? swarm?.rootId;
  const root = (rootId ? byId.get(rootId) : undefined) ?? nodes[0];
  if (!root) return null;
  return swarmNodeItem(root, byParent, new Set(), true, labels, session);
}

function swarmNodeItem(
  node: AgentRuntimeSwarmNode,
  byParent: Map<string, AgentRuntimeSwarmNode[]>,
  seen: Set<string>,
  root: boolean,
  labels: TimelineLabels,
  session: AgentRuntimeSession
): ReasoningTimelineItem {
  if (seen.has(node.id)) {
    return makeItem({
      id: `swarm:${node.id}:cycle`,
      kind: "swarm",
      title: node.name,
      subtitle: node.role,
      summary: "Cycle detected while projecting the recursive chain.",
      status: "blocked"
    });
  }
  const nextSeen = new Set(seen);
  nextSeen.add(node.id);
  const children = (byParent.get(node.id) ?? [])
    .sort((left, right) => swarmStatusRank(left.status) - swarmStatusRank(right.status) || left.name.localeCompare(right.name))
    .slice(0, 24)
    .map((child) => swarmNodeItem(child, byParent, nextSeen, false, labels, session));
  const fileNames = unique([
    ...node.targetFiles,
    ...node.changedFiles,
    ...node.ownedPaths,
    ...children.flatMap((entry) => entry.targetFiles)
  ]);
  const commandCount = root
    ? session.commandRequests.length + session.commandExecutions.length
    : sessionCommandCountFromNode(node);
  return makeItem({
    id: `swarm:${node.id}`,
    kind: "swarm",
    title: root ? labels.title : node.name,
    subtitle: `${node.name} | ${node.role} | ${node.status === "completed" ? labels.complete : node.status.replaceAll("_", " ")}`,
    summary: node.currentAction ?? node.summary ?? node.objective,
    status: node.status,
    createdAt: node.updatedAt,
    facts: [
      fileNames.length ? `${fileNames.length} file${fileNames.length === 1 ? "" : "s"}` : "",
      children.length ? `${children.length} child task${children.length === 1 ? "" : "s"}` : ""
    ],
    targetFiles: fileNames,
    thoughtCount: Math.max(
      1,
      (["group", "work_item", "gate"].includes(node.kind) ? 0 : 1)
        + children.reduce((count, child) => count + child.thoughtCount, 0)
    ),
    fileCount: fileNames.length,
    commandCount,
    children
  });
}

function progressItem(event: RuntimeProgressEvent, labels: TimelineLabels): ReasoningTimelineItem {
  const title = event.taskTitle ?? humanizeProgressStage(event.stage);
  const isCommand = /command|run/i.test(`${title} ${event.summary}`);
  const isFile = /file|evidence|inspect|read|search/i.test(`${title} ${event.summary}`);
  return makeItem({
    id: `progress:${event.id}`,
    kind: isCommand ? "tool" : isFile ? "evidence" : "activity",
    title: title === "Understanding request with provider" ? labels.understanding : title,
    subtitle: event.agentName ? `${event.agentName} | ${humanizeProgressStage(event.stage)}` : humanizeProgressStage(event.stage),
    summary: event.summary,
    status: mapProgressStatus(event.status),
    createdAt: event.createdAt,
    facts: event.targetFiles.length ? [`${event.targetFiles.length} file${event.targetFiles.length === 1 ? "" : "s"}: ${event.targetFiles.slice(0, 4).join(", ")}`] : [],
    targetFiles: event.targetFiles,
    fileCount: event.targetFiles.length,
    commandCount: isCommand ? 1 : 0,
    thoughtCount: event.stage === "planning" || event.stage === "working" ? 1 : 0
  });
}

function selectCurrentItem(session: AgentRuntimeSession, items: ReasoningTimelineItem[], labels: TimelineLabels) {
  let current: ReasoningTimelineItem | undefined;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index]?.status === "running" || items[index]?.status === "queued") {
      current = items[index];
      break;
    }
  }
  if (current) return current;
  if (session.status === "completed" && items.length) return items.at(-1)!;
  if (session.status === "failed" || session.status === "failed_provider") {
    return makeItem({
      id: "reasoning:current:failed",
      kind: "adjustment",
      title: labels.adjustment,
      summary: session.providerTelemetry?.lastError ?? session.runSummary?.summary ?? "The run failed.",
      status: "failed"
    });
  }
  if (items.length) return items.at(-1)!;
  return makeItem({
    id: "reasoning:current:waiting",
    kind: "understanding",
    title: labels.understanding,
    summary: labels.waiting,
    status: isSessionActive(session) ? "running" : "idle"
  });
}

function nextStepFor(session: AgentRuntimeSession, title: string, labels: TimelineLabels) {
  const steps = isArabicReasoningSession(session)
    ? ["فهم الطلب", "قراءة المشروع", "تحديد المسار", "جمع الأدلة", "مراجعة الأدلة", "تجهيز الرد", "التحقق", "النتيجة النهائية"]
    : ["Understanding request", "Reading the workspace", "Choosing a route", "Collecting evidence", "Reviewing evidence", "Drafting the answer", "Verification", "Final response"];
  const index = steps.findIndex((step) => title.toLowerCase().includes(step.toLowerCase()));
  return index >= 0 ? steps[index + 1] : session.nextAction?.message ? session.nextAction.message : undefined;
}

function labelsForSession(session: AgentRuntimeSession): TimelineLabels {
  if (isArabicReasoningSession(session)) {
    return {
      title: "التفكير",
      subtitle: "خطوات واضحة من فهم الطلب إلى النتيجة.",
      understanding: "فهم الطلب",
      step: (index) => `الخطوة ${index}`,
      tool: "تنفيذ أداة",
      files: "عرض الملفات",
      command: "تشغيل أمر",
      evidence: "مراجعة الأدلة",
      verification: "التحقق",
      adjustment: "تعديل المسار",
      final: "الرد النهائي",
      next: "التالي",
      waiting: "بانتظار أول خطوة من المزوّد.",
      working: "يعمل المزوّد على الخطوة الحالية.",
      complete: "تم"
    };
  }
  return {
    title: "Reasoning",
    subtitle: "Visible steps from request understanding to the final result.",
    understanding: "Understanding request",
    step: (index) => `Step ${index}`,
    tool: "Tool action",
    files: "Viewed files",
    command: "Ran command",
    evidence: "Evidence review",
    verification: "Verification",
    adjustment: "Adjusting course",
    final: "Final response",
    next: "Next",
    waiting: "Waiting for the provider to choose the first step.",
    working: "The provider is working on the current step.",
    complete: "Done"
  };
}

function makeItem(input: Partial<ReasoningTimelineItem> & Pick<ReasoningTimelineItem, "id" | "kind" | "title" | "summary" | "status">): ReasoningTimelineItem {
  return {
    id: input.id,
    kind: input.kind,
    title: input.title,
    subtitle: input.subtitle,
    summary: input.summary,
    status: input.status,
    createdAt: input.createdAt,
    rationale: input.rationale,
    facts: compactStrings(input.facts ?? []),
    targetFiles: unique(input.targetFiles ?? []),
    thoughtCount: input.thoughtCount ?? 0,
    fileCount: input.fileCount ?? 0,
    commandCount: input.commandCount ?? 0,
    children: input.children ?? []
  };
}

function getRunActivityProjection(session: AgentRuntimeSession) {
  return session.swarmState?.activityProjection ?? session.recursiveSwarmRunState?.activityProjection;
}

function sessionCommandCountFromNode(node: AgentRuntimeSwarmNode) {
  return node.workItemRefs.length || node.currentAction && /command|run/i.test(node.currentAction) ? 1 : 0;
}

function swarmStatusRank(status: AgentRuntimeSwarmNode["status"]) {
  if (status === "running") return 0;
  if (status === "queued") return 1;
  if (status === "blocked" || status === "failed") return 2;
  if (status === "idle") return 3;
  return 4;
}

function equivalentTimelineItem(left: ReasoningTimelineItem, right: ReasoningTimelineItem) {
  const leftTitle = left.title.toLowerCase().replace(/[^a-z0-9\u0600-\u06ff]+/g, " ").trim();
  const rightTitle = right.title.toLowerCase().replace(/[^a-z0-9\u0600-\u06ff]+/g, " ").trim();
  if (left.kind === right.kind && ["understanding", "result"].includes(left.kind) && leftTitle === rightTitle) return true;
  return leftTitle === rightTitle && left.summary === right.summary;
}

function dedupeTimelineItems(items: ReasoningTimelineItem[]) {
  const result: ReasoningTimelineItem[] = [];
  const seenIds = new Set<string>();
  for (const item of items) {
    if (seenIds.has(item.id)) continue;
    seenIds.add(item.id);
    if (result.some((existing) => equivalentTimelineItem(existing, item))) continue;
    result.push(item);
  }
  return result;
}

function compactStrings(values: string[]) {
  return values.map((value) => value.trim()).filter(Boolean).slice(0, 8);
}

function unique(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function humanizeProgressStage(stage: RuntimeProgressStage) {
  return stage.replaceAll("_", " ").replace(/\b\w/g, (value) => value.toUpperCase());
}

function mapProgressStatus(status: RuntimeProgressStatus): ReasoningTimelineStatus {
  if (status === "blocked") return "blocked";
  if (status === "failed") return "failed";
  if (status === "completed") return "completed";
  if (status === "queued") return "queued";
  return "running";
}

function mapToolStatus(status: string): ReasoningTimelineStatus {
  if (["blocked", "approval_required", "unavailable"].includes(status)) return "blocked";
  if (status === "failed") return "failed";
  if (status === "success") return "completed";
  return "running";
}

function mapSessionStatus(status: AgentRuntimeSession["status"]): ReasoningTimelineStatus {
  if (["blocked", "needs_approval", "paused", "pausing"].includes(status)) return "blocked";
  if (["failed", "failed_provider", "expired"].includes(status)) return "failed";
  if (status === "completed") return "completed";
  if (["running", "resuming"].includes(status)) return "running";
  return "idle";
}

function isSessionActive(session: AgentRuntimeSession) {
  return ["created", "restored", "running", "pausing", "resuming"].includes(session.status);
}

function latestUserMessageCreatedAt(session: AgentRuntimeSession) {
  for (let index = session.messages.length - 1; index >= 0; index -= 1) {
    if (session.messages[index]?.role === "user") return session.messages[index]?.createdAt;
  }
  return undefined;
}
