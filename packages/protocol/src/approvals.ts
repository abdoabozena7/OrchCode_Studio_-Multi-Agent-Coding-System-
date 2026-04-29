export type ApprovalDecision = "approved" | "rejected";

export type AccessProfile =
  | "default_permissions"
  | "auto_review"
  | "full_access"
  | "custom_config";

export type ApprovalRecord = {
  id: string;
  sessionId: string;
  targetType: "patch" | "command";
  targetId: string;
  decision: ApprovalDecision;
  reason?: string;
  createdAt: string;
};

export type SafetySettings = {
  maxParallelAgents: number;
  autoRunSafeCommands: boolean;
  requireApprovalForPatches: boolean;
  autoApplyValidatedPatches: boolean;
  blockDangerousCommands: boolean;
  redactSecrets: boolean;
  allowNetworkCommands: boolean;
};

export const defaultSafetySettings: SafetySettings = {
  maxParallelAgents: 3,
  autoRunSafeCommands: false,
  requireApprovalForPatches: true,
  autoApplyValidatedPatches: false,
  blockDangerousCommands: true,
  redactSecrets: true,
  allowNetworkCommands: false
};

export function accessProfileDefaults(profile: AccessProfile): SafetySettings {
  if (profile === "auto_review") {
    return {
      ...defaultSafetySettings,
      autoRunSafeCommands: true
    };
  }
  if (profile === "full_access") {
    return {
      ...defaultSafetySettings,
      autoRunSafeCommands: true,
      requireApprovalForPatches: false,
      autoApplyValidatedPatches: true
    };
  }
  if (profile === "custom_config") {
    return { ...defaultSafetySettings };
  }
  return { ...defaultSafetySettings };
}
