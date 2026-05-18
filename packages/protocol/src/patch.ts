import type { PatchProposal } from "./models.js";

export type PatchIntentOperation =
  | "create_file"
  | "overwrite_file"
  | "replace_range"
  | "insert_after"
  | "insert_before"
  | "delete_range";

export type RunPatchIntent = {
  path: string;
  operation: PatchIntentOperation;
  anchorText?: string;
  preimageText?: string;
  replacementText: string;
  reason: string;
  risk: PatchProposal["riskLevel"];
};

export type RunPatchIntentModel = {
  title: string;
  summary: string;
  intents: RunPatchIntent[];
  suggestedCommands?: Array<{ command: string; reason: string }>;
  fallbackWarning?: string;
  fallbackKind?: "single_file_pygame" | "simple_file_request" | "generic";
};

export type PatchValidationResult = {
  valid: boolean;
  errors: string[];
  warnings: string[];
};

export type PatchApprovalRequest = {
  sessionId: string;
  patchId: string;
};

export type PatchApprovalResponse = {
  proposal: PatchProposal;
  applied: boolean;
  message: string;
};
