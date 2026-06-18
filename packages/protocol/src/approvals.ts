export type ApprovalDecision = "approved" | "rejected" | "changes_requested";

export type AccessProfile =
  | "default_permissions"
  | "auto_review"
  | "bounded_autonomy"
  | "full_access"
  | "custom_config";

export type LegacyAccessProfile = never;

export type AccessProfileInput = AccessProfile;

export type RunTrustProfile = "strict_gated" | "trusted_internal";

export type DeclaredCapability =
  | "read_workspace"
  | "write_workspace"
  | "propose_patch"
  | "apply_patch"
  | "request_command"
  | "execute_safe_command"
  | "execute_medium_command"
  | "execute_dangerous_command"
  | "use_network";

export type ResolvedCapability =
  | DeclaredCapability
  | "restore_session"
  | "replay_session_history";

export type AuthorityLevel =
  | "human_gated"
  | "review_required"
  | "bounded_autonomy"
  | "backend_enforced";

export type ApprovalRequirement =
  | "patch_proposal"
  | "patch_apply"
  | "command_execution"
  | "dangerous_command"
  | "session_restore";

export type DeclaredAccessPolicy = {
  accessProfile: AccessProfile;
  trustProfile: RunTrustProfile;
  requestedAuthority: AuthorityLevel;
  requestedCapabilities: DeclaredCapability[];
  note?: string;
};

export type ResolvedAccessPolicy = {
  declared: DeclaredAccessPolicy;
  enforcedAuthority: AuthorityLevel;
  effectiveCapabilities: ResolvedCapability[];
  blockedCapabilities: ResolvedCapability[];
  requiresApprovalFor: ApprovalRequirement[];
  backendRestrictions: string[];
  resolvedBy: "runtime" | "desktop" | "backend" | "unknown";
  resolvedAt?: string;
};

export function declaredAccessPolicyForProfile(profile: AccessProfileInput): DeclaredAccessPolicy {
  const normalizedProfile = normalizeAccessProfile(profile);
  const trustProfile = trustProfileFromAccessProfile(normalizedProfile);

  if (normalizedProfile === "full_access") {
    return {
      accessProfile: normalizedProfile,
      trustProfile,
      requestedAuthority: "backend_enforced",
      requestedCapabilities: [
        "read_workspace",
        "write_workspace",
        "propose_patch",
        "apply_patch",
        "request_command",
        "execute_safe_command",
        "execute_medium_command",
        "execute_dangerous_command",
        "use_network"
      ],
      note: "Full Access is a trusted local profile that auto-applies validated workspace patches and auto-runs requested commands while preserving provenance."
    };
  }

  if (normalizedProfile === "bounded_autonomy") {
    return {
      accessProfile: normalizedProfile,
      trustProfile,
      requestedAuthority: "bounded_autonomy",
      requestedCapabilities: [
        "read_workspace",
        "write_workspace",
        "propose_patch",
        "apply_patch",
        "request_command",
        "execute_safe_command"
      ],
      note: "Declared bounded autonomy still depends on Rust-side apply and command authority."
    };
  }

  if (normalizedProfile === "auto_review") {
    return {
      accessProfile: normalizedProfile,
      trustProfile,
      requestedAuthority: "review_required",
      requestedCapabilities: [
        "read_workspace",
        "propose_patch",
        "request_command",
        "execute_safe_command"
      ]
    };
  }

  if (normalizedProfile === "custom_config") {
    return {
      accessProfile: normalizedProfile,
      trustProfile,
      requestedAuthority: "human_gated",
      requestedCapabilities: ["read_workspace", "propose_patch", "request_command"],
      note: "Custom policy remains a reserved surface until backend enforcement is implemented."
    };
  }

  return {
    accessProfile: normalizedProfile,
    trustProfile,
    requestedAuthority: "human_gated",
    requestedCapabilities: ["read_workspace", "propose_patch", "request_command"]
  };
}

export function resolvedAccessPolicyForProfile(profile: AccessProfileInput): ResolvedAccessPolicy {
  const declared = declaredAccessPolicyForProfile(profile);
  const baseRestrictions = [
    "Patch application is performed by Rust authority.",
    "Session restore requires a valid session token and persisted runtime snapshot.",
    "Command policy remains heuristic and is recorded as provenance."
  ];

  if (declared.accessProfile === "full_access") {
    return {
      declared,
      enforcedAuthority: "backend_enforced",
      effectiveCapabilities: [
        "read_workspace",
        "write_workspace",
        "propose_patch",
        "apply_patch",
        "request_command",
        "execute_safe_command",
        "execute_medium_command",
        "execute_dangerous_command",
        "use_network",
        "restore_session"
      ],
      blockedCapabilities: [],
      requiresApprovalFor: ["session_restore"],
      backendRestrictions: baseRestrictions,
      resolvedBy: "backend",
      resolvedAt: new Date().toISOString()
    };
  }

  const baseBlocked: ResolvedCapability[] = ["execute_dangerous_command", "use_network"];

  if (declared.accessProfile === "bounded_autonomy") {
    return {
      declared,
      enforcedAuthority: "review_required",
      effectiveCapabilities: [
        "read_workspace",
        "write_workspace",
        "propose_patch",
        "apply_patch",
        "request_command",
        "execute_safe_command",
        "restore_session"
      ],
      blockedCapabilities: baseBlocked,
      requiresApprovalFor: ["patch_apply", "command_execution", "dangerous_command"],
      backendRestrictions: baseRestrictions,
      resolvedBy: "backend",
      resolvedAt: new Date().toISOString()
    };
  }

  if (declared.accessProfile === "auto_review") {
    return {
      declared,
      enforcedAuthority: "review_required",
      effectiveCapabilities: [
        "read_workspace",
        "propose_patch",
        "request_command",
        "execute_safe_command",
        "restore_session"
      ],
      blockedCapabilities: ["write_workspace", "apply_patch", ...baseBlocked],
      requiresApprovalFor: ["patch_proposal", "patch_apply", "command_execution", "dangerous_command"],
      backendRestrictions: baseRestrictions,
      resolvedBy: "backend",
      resolvedAt: new Date().toISOString()
    };
  }

  return {
    declared,
    enforcedAuthority: "human_gated",
    effectiveCapabilities: ["read_workspace", "propose_patch", "request_command", "restore_session"],
    blockedCapabilities: ["write_workspace", "apply_patch", "execute_safe_command", ...baseBlocked],
    requiresApprovalFor: ["patch_proposal", "patch_apply", "command_execution", "dangerous_command", "session_restore"],
    backendRestrictions: baseRestrictions,
    resolvedBy: "backend",
    resolvedAt: new Date().toISOString()
  };
}

export type ApprovalRecord = {
  id: string;
  sessionId: string;
  targetType: "patch" | "command" | "product_spec" | "technical_plan";
  targetId: string;
  decision: ApprovalDecision;
  reason?: string;
  createdAt: string;
};

export type SafetySettings = {
  maxParallelAgents: number;
  autoRunSafeCommands: boolean;
  autoRunMediumCommands: boolean;
  autoRunBackgroundCommands: boolean;
  autoRunNetworkCommands: boolean;
  requireApprovalForPatches: boolean;
  autoApplyValidatedPatches: boolean;
  blockDangerousCommands: boolean;
  redactSecrets: boolean;
  allowNetworkCommands: boolean;
};

export const defaultSafetySettings: SafetySettings = {
  maxParallelAgents: 3,
  autoRunSafeCommands: false,
  autoRunMediumCommands: false,
  autoRunBackgroundCommands: false,
  autoRunNetworkCommands: false,
  requireApprovalForPatches: true,
  autoApplyValidatedPatches: false,
  blockDangerousCommands: true,
  redactSecrets: true,
  allowNetworkCommands: false
};

export function normalizeAccessProfile(profile: AccessProfileInput): AccessProfile {
  return profile;
}

export function accessProfileDefaults(profile: AccessProfileInput): SafetySettings {
  const normalizedProfile = normalizeAccessProfile(profile);

  if (normalizedProfile === "auto_review") {
    return {
      ...defaultSafetySettings,
      autoRunSafeCommands: true
    };
  }
  if (normalizedProfile === "bounded_autonomy") {
    return {
      ...defaultSafetySettings,
      autoRunSafeCommands: true
    };
  }
  if (normalizedProfile === "full_access") {
    return {
      ...defaultSafetySettings,
      autoRunSafeCommands: true,
      autoRunMediumCommands: true,
      autoRunBackgroundCommands: true,
      autoRunNetworkCommands: true,
      requireApprovalForPatches: false,
      autoApplyValidatedPatches: true,
      blockDangerousCommands: false,
      allowNetworkCommands: true
    };
  }
  if (normalizedProfile === "custom_config") {
    return { ...defaultSafetySettings };
  }
  return { ...defaultSafetySettings };
}

export function safetySettingsForTrustProfile(profile: RunTrustProfile): SafetySettings {
  if (profile === "trusted_internal") {
    return {
      ...defaultSafetySettings,
      autoRunSafeCommands: true,
      requireApprovalForPatches: true,
      autoApplyValidatedPatches: false
    };
  }
  return { ...defaultSafetySettings };
}

export function trustProfileFromAccessProfile(profile: AccessProfileInput): RunTrustProfile {
  const normalizedProfile = normalizeAccessProfile(profile);
  return normalizedProfile === "auto_review" || normalizedProfile === "bounded_autonomy" || normalizedProfile === "full_access"
    ? "trusted_internal"
    : "strict_gated";
}
