import type { PatchProposal } from "./models.js";

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
