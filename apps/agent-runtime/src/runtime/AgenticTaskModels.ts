import type { EvidenceProvenance, EvidenceSourceType } from "@hivo/protocol";
import type { LlmProvider } from "../llm/LlmProvider.js";
import type { ToolRegistry } from "../tools/ToolRegistry.js";

export type AgenticTaskMode =
  | "project_explain"
  | "architecture_explain"
  | "feature_explain"
  | "feature_existence"
  | "data_flow"
  | "ui_flow"
  | "backend_flow"
  | "config_explain"
  | "design_assessment"
  | "debugging_analysis"
  | "refactor_planning"
  | "coding_planning"
  | "patch_preparation"
  | "review_reasoning"
  | "validation_planning"
  | "repair_planning"
  | "docs_generation"
  | "unknown";

export type AgenticEvidenceType =
  | "production_source"
  | "test"
  | "fixture"
  | "smoke"
  | "tmp"
  | "generated"
  | "config"
  | "docs"
  | "memory"
  | "artifact"
  | "unknown";

export type AgenticProvenanceStatus = "accepted" | "downgraded" | "rejected";
export type AgenticReadMode = "full_file" | "symbol_window" | "snippet" | "import_follow" | "config_follow" | "artifact_follow";
export type AgenticClaimStatus = "supported" | "partially_supported" | "unsupported" | "contradicted" | "opinion" | "unknown";
export type AgenticFallbackReason =
  | "provider_timeout"
  | "provider_failed"
  | "provider_invalid_json"
  | "insufficient_evidence"
  | "claim_validation_failed"
  | "kernel_disabled"
  | "adapter_not_available"
  | "none";

export type AgenticTaskKernelConfig = {
  agenticTaskKernelEnabled: boolean;
  agenticTaskKernelMode: "off" | "auto" | "force";
  agenticTaskMaxOpenedFiles: number;
  agenticTaskMaxRelationshipDepth: number;
  agenticTaskMaxFileChars: number;
  agenticTaskMaxTotalReadChars: number;
  agenticTaskMaxEvidenceItems: number;
  agenticTaskProviderTimeoutMs: number;
  agenticTaskAllowNaturalDraft: boolean;
  agenticTaskClaimValidationRequired: boolean;
  agenticTaskDisableGenericFallbackForComplexQuestions: boolean;
  projectExplainUseAgenticKernel: boolean;
};

export type AgenticTaskRequest = {
  id?: string;
  prompt: string;
  workspacePath: string;
  modeHint?: AgenticTaskMode;
  adapterId?: string;
  provider?: LlmProvider;
  tools: ToolRegistry;
  config?: Partial<AgenticTaskKernelConfig>;
  metadata?: Record<string, unknown>;
};

export type AgenticTaskIntent = {
  mode: AgenticTaskMode;
  language: "arabic" | "english";
  topic: string;
  terms: string[];
  aliases: string[];
  targetPaths: string[];
  requiresProductionEvidence: boolean;
  complexity: "simple" | "complex";
  confidence: "high" | "medium" | "low";
};

export type AgenticReadBudget = {
  maxOpenedFiles: number;
  maxRelationshipDepth: number;
  maxCharsPerFile: number;
  maxTotalChars: number;
  maxEvidenceItems: number;
  timeoutMs: number;
};

export type AgenticReadStep = {
  id: string;
  kind: "seed" | "term_search" | "path_open" | "import_follow" | "route_follow" | "config_follow" | "test_follow" | "artifact_follow";
  reason: string;
  terms: string[];
  paths: string[];
  depth: number;
  readMode: AgenticReadMode;
  required: boolean;
};

export type AgenticReadPlan = {
  mode: AgenticTaskMode;
  strategy: string;
  budget: AgenticReadBudget;
  steps: AgenticReadStep[];
};

export type AgenticOpenedFile = {
  path: string;
  content: string;
  truncated: boolean;
  charsRead: number;
  openedBecause: string[];
  readMode: AgenticReadMode;
};

export type AgenticFileSummary = {
  path: string;
  kind: AgenticEvidenceType;
  symbols: string[];
  imports: string[];
  exports: string[];
  routes: string[];
  calls: string[];
  summary: string;
};

export type AgenticRelationship = {
  fromPath: string;
  toPath?: string;
  symbol?: string;
  kind: "import" | "export" | "call" | "route" | "config" | "ui_runtime" | "protocol_type" | "test_to_source" | "dependency";
  reason: string;
  depth: number;
  confidence: "high" | "medium" | "low";
};

export type AgenticEvidenceItem = {
  id: string;
  path: string;
  lineStart?: number;
  lineEnd?: number;
  symbol?: string;
  evidenceType: AgenticEvidenceType;
  sourceType: EvidenceSourceType;
  provenanceStatus: AgenticProvenanceStatus;
  provenance: EvidenceProvenance;
  relevanceReason: string;
  readMode: AgenticReadMode;
  supportedClaimIds: string[];
  canSupportProductionBehavior: boolean;
  confidence: "high" | "medium" | "low";
  freshness: "current_workspace" | "stale_or_unknown";
  snippet: string;
};

export type AgenticEvidenceGraph = {
  items: AgenticEvidenceItem[];
  relationships: AgenticRelationship[];
  accepted: AgenticEvidenceItem[];
  downgraded: AgenticEvidenceItem[];
  rejected: AgenticEvidenceItem[];
  byPath: Record<string, AgenticEvidenceItem[]>;
  summary: {
    productionEvidenceCount: number;
    supportEvidenceCount: number;
    rejectedEvidenceCount: number;
    confidence: "high" | "medium" | "low";
  };
};

export type AgenticMentalModel = {
  relevantComponents: Array<{ name: string; paths: string[]; evidenceIds: string[] }>;
  responsibilities: Array<{ component: string; summary: string; evidenceIds: string[] }>;
  relationships: AgenticRelationship[];
  dataOrControlFlow: string[];
  importantFiles: string[];
  risks: string[];
  unknowns: string[];
  testOrSupportEvidence: string[];
  productionEvidence: string[];
  rejectedOrDowngradedEvidence: string[];
  confidence: "high" | "medium" | "low";
};

export type AgenticClaimSupport = {
  evidenceId: string;
  ref: string;
  status: AgenticClaimStatus;
  reason: string;
};

export type AgenticClaim = {
  id: string;
  text: string;
  status: AgenticClaimStatus;
  support: AgenticClaimSupport[];
  material: boolean;
};

export type AgenticOutputDraft = {
  format: "markdown" | "structured";
  text: string;
  claims: AgenticClaim[];
  fallbackReason?: AgenticFallbackReason;
};

export type AgenticFinalOutput = {
  markdown: string;
  claims: AgenticClaim[];
  validationStatus: "valid" | "qualified" | "blocked";
  warnings: string[];
  citations: string[];
};

export type AgenticReasoningTrace = {
  taskMode: AgenticTaskMode;
  detectedIntent: AgenticTaskIntent;
  readPlan: AgenticReadPlan;
  openedFiles: AgenticOpenedFile[];
  fileSummaries: AgenticFileSummary[];
  relationshipsFollowed: AgenticRelationship[];
  evidenceAccepted: string[];
  evidenceDowngraded: string[];
  evidenceRejected: string[];
  providerCalls: Array<{ kind: "intent" | "draft" | "claim_extraction" | "synthesis_hint"; status: "skipped" | "success" | "failed" | "timeout"; reason?: string }>;
  fallbackReason: AgenticFallbackReason;
  claimValidationSummary: Record<AgenticClaimStatus, number>;
  finalOutputValidationStatus: AgenticFinalOutput["validationStatus"];
};

export type AgenticTaskResult = {
  request: AgenticTaskRequest;
  intent: AgenticTaskIntent;
  readPlan: AgenticReadPlan;
  openedFiles: AgenticOpenedFile[];
  fileSummaries: AgenticFileSummary[];
  evidenceGraph: AgenticEvidenceGraph;
  mentalModel: AgenticMentalModel;
  draft: AgenticOutputDraft;
  finalOutput: AgenticFinalOutput;
  trace: AgenticReasoningTrace;
};

export type AgenticTaskAdapter<TInput = unknown, TOutput = unknown> = {
  id: string;
  modes: AgenticTaskMode[];
  canHandle(request: AgenticTaskRequest): boolean;
  toRequest(input: TInput): AgenticTaskRequest;
  fromResult(result: AgenticTaskResult): TOutput;
};

export function defaultAgenticTaskKernelConfig(): AgenticTaskKernelConfig {
  return {
    agenticTaskKernelEnabled: true,
    agenticTaskKernelMode: "auto",
    agenticTaskMaxOpenedFiles: 24,
    agenticTaskMaxRelationshipDepth: 1,
    agenticTaskMaxFileChars: 24_000,
    agenticTaskMaxTotalReadChars: 140_000,
    agenticTaskMaxEvidenceItems: 80,
    agenticTaskProviderTimeoutMs: 12_000,
    agenticTaskAllowNaturalDraft: true,
    agenticTaskClaimValidationRequired: true,
    agenticTaskDisableGenericFallbackForComplexQuestions: true,
    projectExplainUseAgenticKernel: true
  };
}

export function mergeAgenticTaskKernelConfig(input?: Partial<AgenticTaskKernelConfig>): AgenticTaskKernelConfig {
  return {
    ...defaultAgenticTaskKernelConfig(),
    ...input
  };
}
