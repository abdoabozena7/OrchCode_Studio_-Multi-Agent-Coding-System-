export type FrontendStructureFacts = {
  kind: "frontend_structure";
  totalItems: number;
  items: Array<{
    name: string;
    type: "route" | "page" | "section" | "tab" | "component";
    purpose: string;
    sourceRef: string;
    confidence: "high" | "medium" | "low";
  }>;
  hasRouter: boolean;
  isSinglePageApp: boolean;
  inspectedFiles: string[];
  uncertainties: string[];
};

export type AlgorithmInventoryFacts = {
  kind: "algorithm_inventory";
  items: Array<{
    name: string;
    canonicalName: string;
    classification: "predictive_model" | "clustering_algorithm" | "forecasting_model" | "explainability_method" | "service_wrapper";
    description: string;
    sourceRef: string;
    confidence: "high" | "medium" | "low";
  }>;
  deduplicatedCount: number;
  inspectedFiles: string[];
  uncertainties: string[];
};

export type TrainingInferenceFacts = {
  kind: "training_inference";
  separation: "yes" | "partial" | "no" | "unclear";
  training: Array<{ name: string; type: "function" | "class" | "endpoint"; sourceRef: string; }>;
  inference: Array<{ name: string; type: "function" | "class" | "endpoint"; sourceRef: string; }>;
  persistence: Array<{ method: string; sourceRef: string; }>;
  inspectedFiles: string[];
  uncertainties: string[];
};

export type CodeFlowFacts = {
  kind: "code_flow";
  steps: Array<{
    order: number;
    label: string;
    description: string;
    sourceRef: string;
    proven: boolean;
  }>;
  inspectedFiles: string[];
  uncertainties: string[];
};

export type ApiRouteFlowFacts = {
  kind: "api_route_flow";
  routes: Array<{
    path: string;
    method: string;
    handler: string;
    calls: string[];
    sourceRef: string;
  }>;
  inspectedFiles: string[];
  uncertainties: string[];
};

export type UIControlFacts = {
  kind: "ui_controls";
  controls: Array<{
    text: string;
    type: "button" | "submit_input" | "link" | "icon" | "other";
    action: string;
    sourceRef: string;
    confidence: "high" | "medium" | "low";
  }>;
  inspectedFiles: string[];
  uncertainties: string[];
};

export type InspectExplainFacts = {
  kind: "inspect_explain";
  frontend?: FrontendStructureFacts;
  uiControls?: UIControlFacts;
  algorithms?: AlgorithmInventoryFacts;
  trainingInference?: TrainingInferenceFacts;
  codeFlow?: CodeFlowFacts;
  apiRouteFlow?: ApiRouteFlowFacts;
  inspectedFiles: string[];
  uncertainties: string[];
};
