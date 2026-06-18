export type ProjectUnderstandingKernelMode = "off" | "shadow" | "on";

export type ReasoningRoute =
  | "chat"
  | "inspect_explain"
  | "simple_run"
  | "orchestrated_run"
  | "recursive_factory"
  | "swarm_readonly";

export type TurnUnderstanding = {
  originalRequest: string;
  cleanedRequest: string;
  language: "arabic" | "english";
  intentKind: "direct_conversation" | "workspace_question" | "workspace_action" | "run_request";
  route: ReasoningRoute;
  needsWorkspace: boolean;
  goal: string;
  ambiguities: string[];
  requiredEvidence: string[];
  risk: "low" | "medium" | "high";
  confidence: "high" | "medium" | "low";
  rationale: string;
};

export type ReasoningToolRequest = {
  id: string;
  kind:
    | "list_files"
    | "repository_search"
    | "read_file"
    | "inspect_manifest"
    | "investigate_project"
    | "semantic_search"
    | "follow_relationships"
    | "read_semantic_sources"
    | "run_command"
    | "propose_patch"
    | "analyze_project"
    | "delegate_readonly";
  reason: string;
  query?: string;
  path?: string;
  paths?: string[];
  command?: string;
  limit?: number;
  relatedNodeIds?: string[];
  patch?: {
    title: string;
    summary: string;
    filesChanged: Array<{ path: string; changeType: "create" | "modify" | "delete"; summary: string }>;
    unifiedDiff: string;
    riskLevel: "low" | "medium" | "high";
    rollbackPlan: string;
  };
};

/**
 * @deprecated Compatibility projection for persisted v1 decision-pipeline records.
 * Providers are asked for InitialReasoningDecision and ReasoningStep, never ReasoningDirective.
 */
export type ReasoningDirective = {
  action: "answer" | "investigate" | "plan" | "execute" | "ask_user" | "cannot_answer" | "refuse" | "escalate";
  rationale: string;
  toolRequests: ReasoningToolRequest[];
  missingFacts: string[];
  successCriteria: string[];
};

export type ReasoningEvidenceRef = {
  id: string;
  sourceType: "workspace_file" | "workspace_listing" | "manifest" | "investigation_bundle" | "semantic_node" | "semantic_relationship" | "command_result" | "patch_validation" | "delegated_review";
  summary: string;
  path?: string;
  startLine?: number;
  endLine?: number;
  contentHash?: string;
  excerpt?: string;
  createdAt: string;
};

export type ProviderClaim = {
  id: string;
  text: string;
  material: boolean;
  evidenceIds: string[];
  confidence: "high" | "medium" | "low";
};

export type ProviderAuthoredResult = {
  decision: "ANSWER" | "FOLLOW_UP" | "REFUSE" | "ESCALATE";
  answerMarkdown: string;
  claims: Array<ProviderClaim | string>;
  evidenceRefs: string[];
  unknowns: string[];
  rationale: string;
};

export type ReasoningToolResult = {
  requestId: string;
  kind: ReasoningToolRequest["kind"];
  status: "success" | "failed" | "blocked" | "approval_required" | "unavailable";
  summary: string;
  evidenceRefs: ReasoningEvidenceRef[];
  data?: unknown;
  error?: string;
  approvalRef?: string;
  createdAt: string;
};

export type ReasoningStep = {
  id: string;
  kind: "tool_batch" | "final" | "ask_user" | "refuse" | "escalate";
  rationale: string;
  toolRequests: ReasoningToolRequest[];
  result?: ProviderAuthoredResult;
  missingFacts: string[];
  successCriteria: string[];
  expectedInformationGain?: string;
  targetUnknowns?: string[];
  stopCondition?: string;
};

export type InitialReasoningDecision = {
  understanding: TurnUnderstanding;
  step: ReasoningStep;
};

export type ReasoningBudget = {
  profile: "conversation" | "project" | "deep_project" | "action";
  maxProviderCalls: number;
  maxToolRounds: number;
  maxRepairAttempts: number;
  maxElapsedMs: number;
};

export type ReasoningStage =
  | "route"
  | "audit"
  | "investigate"
  | "reason"
  | "curate"
  | "compose"
  | "verify"
  | "repair";

export type ReasoningStageBudget = {
  stage: ReasoningStage;
  maxElapsedMs: number;
  maxOutputTokens: number;
  reserveMs: number;
};

export type ReasoningProgress = {
  round: number;
  newEvidenceCount: number;
  newFileCount: number;
  newRelationshipCount: number;
  informationGain: number;
  stagnant: boolean;
  reason: string;
  createdAt: string;
};

export type IndexReadinessRecord = {
  before: "fresh" | "stale" | "missing";
  after: "fresh" | "stale" | "missing";
  refreshed: boolean;
  error?: string;
  createdAt: string;
};

export type StructuredRepairError = {
  kind:
    | "wrong_route"
    | "insufficient_evidence"
    | "unsupported_claim"
    | "stagnation"
    | "malformed_result"
    | "unsafe_action"
    | "provider_failure";
  message: string;
  stage: ReasoningStage;
  createdAt: string;
};

export type InvestigationBundle = {
  query: string;
  freshness: "fresh" | "stale" | "missing";
  retrieval: {
    textMatches: number;
    semanticNodes: number;
    relationships: number;
    sourceFiles: number;
    vectorUsed: boolean;
    vectorUnavailableReason?: string;
  };
  candidatePaths: string[];
  relatedNodeIds: string[];
  relationshipIds: string[];
  evidenceIds: string[];
};

export type ReasoningVerificationResult = {
  verdict: "pass" | "fail" | "needs_more_evidence";
  rationale: string;
  workspaceEvidenceRequired?: boolean;
  recommendedBudgetProfile?: "conversation" | "project" | "deep_project" | "action";
  supportedClaims: string[];
  unsupportedClaims: string[];
  missingFacts: string[];
  evidenceRefs: string[];
  createdAt: string;
};

export type ReasoningTurnTrace = {
  id: string;
  understanding: TurnUnderstanding;
  steps: ReasoningStep[];
  toolResults: ReasoningToolResult[];
  evidenceRefs: ReasoningEvidenceRef[];
  budget: ReasoningBudget;
  providerCalls: number;
  reasoningAttempts: number;
  repairAttempts: number;
  toolRounds: number;
  verificationResults: ReasoningVerificationResult[];
  contextOmissions: Array<{
    stage: "reason" | "compose" | "verify";
    omittedEvidenceIds: string[];
    selectedEvidenceIds: string[];
    maxChars: number;
  }>;
  stageBudgets: ReasoningStageBudget[];
  progress: ReasoningProgress[];
  repairErrors: StructuredRepairError[];
  indexReadiness?: IndexReadinessRecord;
  providerRequestRefs: string[];
  terminalFailure?: string;
  startedAt: string;
  completedAt?: string;
};

export type ProjectRelationshipKind =
  | "import"
  | "export"
  | "call"
  | "route"
  | "ui_to_api"
  | "storage"
  | "produces"
  | "consumes"
  | "test_to_source"
  | "concept_alias";

export type QuestionDecomposition = {
  question: string;
  concepts: string[];
  requiredRelationships: Array<{
    fromConcept: string;
    toConcept: string;
    kind?: ProjectRelationshipKind;
    required: boolean;
    rationale: string;
  }>;
  ambiguities: string[];
  expectedAnswerShape: "summary" | "flow" | "comparison" | "decision_policy" | "existence" | "judgment";
  language: "arabic" | "english";
};

export type InvestigationAction = {
  id: string;
  kind: "semantic_search" | "open_file" | "follow_relationship" | "request_review" | "mark_unknown";
  status: "planned" | "completed" | "blocked" | "skipped";
  reason: string;
  query?: string;
  path?: string;
  relationshipId?: string;
  evidenceRefs: string[];
};

export type ProjectClaim = {
  id: string;
  text: string;
  material: boolean;
  status: "supported" | "partially_supported" | "unsupported" | "contradicted" | "unknown";
  evidenceRefs: string[];
  relationshipIds: string[];
  reason: string;
};

export type ClaimLedger = {
  claims: ProjectClaim[];
  supportedMaterialClaims: number;
  unsupportedMaterialClaims: number;
  allMaterialClaimsSupported: boolean;
};

export type ClarificationClassification = {
  fact: string;
  classification: "user_blocker" | "discoverable" | "safe_assumption" | "deferred_unknown";
  rationale: string;
};

export type ProjectUnderstandingAnswer = {
  mode: ProjectUnderstandingKernelMode;
  status: "answered" | "follow_up" | "escalate" | "refused" | "shadow_complete" | "blocked";
  decomposition: QuestionDecomposition;
  investigationActions: InvestigationAction[];
  claimLedger: ClaimLedger;
  clarification: ClarificationClassification[];
  filesRead: string[];
  graphExpansionTrace: string[];
  repairIterations: number;
  providerCalls: number;
  elapsedMs: number;
  evidenceRefs: string[];
  unknowns: string[];
  finalAnswerMarkdown: string;
  decision: "ANSWER" | "FOLLOW_UP" | "REFUSE" | "ESCALATE";
  decisionReason: string;
  escalationUsed: boolean;
};
