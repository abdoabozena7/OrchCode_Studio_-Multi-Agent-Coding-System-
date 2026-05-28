import type { ContextPack, Task } from "./OrchestrationModels.js";

export const FACTORY_LOCK_SCHEMA_VERSION = 1;

export type FactoryLockType = "file" | "directory" | "module" | "semantic" | "campaign" | "task" | "advisory";
export type FactoryLockMode = "read" | "write" | "exclusive" | "advisory";
export type FactoryLockStatus =
  | "requested"
  | "acquired"
  | "rejected"
  | "expired"
  | "released"
  | "stolen_or_recovered"
  | "abandoned"
  | "failed";

export type FactoryLockScope = {
  type: FactoryLockType;
  mode: FactoryLockMode;
  scope: string;
  normalized_scope_key: string;
  confidence: "high" | "medium" | "low";
  reason: string;
  metadata_json?: Record<string, unknown>;
};

export type FactoryLock = {
  schema_version: number;
  lock_id: string;
  run_id: string;
  task_id?: string;
  agent_id?: string;
  work_item_id?: string;
  lock_type: FactoryLockType;
  lock_mode: FactoryLockMode;
  lock_scope: string;
  normalized_scope_key: string;
  owner_component: string;
  status: FactoryLockStatus;
  reason: string;
  conflict_with_lock_id?: string;
  acquired_at?: string;
  expires_at?: string;
  released_at?: string;
  heartbeat_at?: string;
  trace_event_id?: string;
  metadata_json: Record<string, unknown>;
};

export type LockConflict = {
  conflict_id: string;
  requested_scope: FactoryLockScope;
  existing_lock: FactoryLock;
  reason: string;
  blocking: boolean;
};

export type LockAcquisitionRequest = {
  request_id: string;
  run_id: string;
  task_id?: string;
  agent_id?: string;
  work_item_id?: string;
  owner_component: string;
  scopes: FactoryLockScope[];
  ttl_ms?: number;
  reason: string;
  metadata_json?: Record<string, unknown>;
};

export type LockAcquisitionResult = {
  acquired: boolean;
  request: LockAcquisitionRequest;
  locks: FactoryLock[];
  conflicts: LockConflict[];
  requested_paths: string[];
  artifact_refs: string[];
};

export type LockReleaseResult = {
  released: FactoryLock[];
  not_found: string[];
  artifact_refs: string[];
};

export type LockRecoveryResult = {
  recovered: FactoryLock[];
  expired: FactoryLock[];
  artifact_refs: string[];
};

export type SemanticLockKey =
  | "semantic:public-api"
  | "semantic:database-schema"
  | "semantic:validation-runner"
  | "semantic:prompt-system"
  | "semantic:lock-manager"
  | "semantic:factory-metadata"
  | "semantic:project-config"
  | "semantic:security-sensitive"
  | "semantic:dependency-manifest"
  | `semantic:${string}`;

export type ModuleLockKey =
  | "module:orchestration"
  | "module:runtime"
  | "module:memory"
  | "module:swarm"
  | "module:desktop-rust"
  | "module:desktop-ui"
  | "module:protocol"
  | `module:${string}`;

export function lockModeBlocks(requested: FactoryLockMode, existing: FactoryLockMode) {
  if (requested === "advisory" || existing === "advisory") return false;
  if (requested === "read" && existing === "read") return false;
  return requested === "exclusive" || existing === "exclusive" || requested === "write" || existing === "write";
}

export function isActiveLockStatus(status: FactoryLockStatus) {
  return status === "requested" || status === "acquired";
}

export function semanticLocksForTask(task: Task, contextPack?: ContextPack, mode: FactoryLockMode = "write"): FactoryLockScope[] {
  const files = uniqueStrings([
    ...task.allowed_files_to_edit,
    ...task.relevant_files,
    ...(contextPack?.relevant_files ?? []),
    ...(contextPack?.included_items ?? []).map((item) => item.source_path ?? item.source_ref)
  ]);
  const scopes: FactoryLockScope[] = [];
  const add = (key: SemanticLockKey, confidence: FactoryLockScope["confidence"], reason: string) => {
    scopes.push({
      type: confidence === "low" ? "advisory" : "semantic",
      mode: confidence === "low" ? "advisory" : mode,
      scope: key,
      normalized_scope_key: key,
      confidence,
      reason,
      metadata_json: { derived_from_files: files.filter((file) => semanticMatchesFile(key, file)) }
    });
  };
  if (files.some((file) => /FactoryMetadataStore|factory_metadata|sqlite|schema|migration/i.test(file))) add("semantic:database-schema", "high", "Task touches metadata schema or SQLite persistence.");
  if (files.some((file) => /PromptSystem|PromptQualityGate|PromptWriter|prompts?\//i.test(file))) add("semantic:prompt-system", "high", "Task touches prompt rendering or prompt quality surfaces.");
  if (files.some((file) => /ValidationRunner|ValidationSemantics|validation/i.test(file))) add("semantic:validation-runner", "medium", "Task touches validation orchestration.");
  if (files.some((file) => /LockManager|DurableLock|factory_locks|locks/i.test(file))) add("semantic:lock-manager", "high", "Task touches lock management.");
  if (files.some((file) => /FactoryMetadataStore|FactoryTrace|factory_/i.test(file))) add("semantic:factory-metadata", "high", "Task touches factory metadata or trace surfaces.");
  if (files.some((file) => /(^|\/)(package\.json|package-lock\.json|cargo\.toml|cargo\.lock|tsconfig[^/]*\.json|vite\.config|tauri\.conf)/i.test(file))) add("semantic:project-config", "high", "Task touches project configuration.");
  if (files.some((file) => /(^|\/)(package\.json|package-lock\.json|cargo\.toml|cargo\.lock)/i.test(file))) add("semantic:dependency-manifest", "high", "Task touches dependency manifests.");
  if (files.some((file) => /\.env|security|auth|secret|token|CommandPolicy|Approval/i.test(file))) add("semantic:security-sensitive", "high", "Task touches security-sensitive surfaces.");
  if (files.some((file) => /packages\/protocol|src\/server|public api|api/i.test(file))) add("semantic:public-api", "medium", "Task may affect public API contracts.");
  if (!scopes.length) {
    scopes.push({
      type: "advisory",
      mode: "advisory",
      scope: "semantic:unknown",
      normalized_scope_key: "semantic:unknown",
      confidence: "low",
      reason: "Semantic lock confidence is low; advisory only.",
      metadata_json: { derived_from_files: files.slice(0, 20) }
    });
  }
  return uniqueScopes(scopes);
}

export function moduleLocksForTask(task: Task, contextPack?: ContextPack, mode: FactoryLockMode = "write"): FactoryLockScope[] {
  const files = uniqueStrings([
    ...task.allowed_files_to_edit,
    ...task.relevant_files,
    ...(contextPack?.relevant_files ?? [])
  ]);
  const scopes = files.flatMap((file) => {
    const key = moduleKeyForPath(file);
    return key ? [{
      type: "module" as const,
      mode,
      scope: key,
      normalized_scope_key: key,
      confidence: "high" as const,
      reason: `Derived module lock from ${file}.`,
      metadata_json: { path: file }
    }] : [];
  });
  return uniqueScopes(scopes);
}

export function moduleKeyForPath(filePath: string): ModuleLockKey | undefined {
  const normalized = filePath.replace(/\\/g, "/").toLowerCase();
  if (normalized.includes("apps/agent-runtime/src/orchestration/")) return "module:orchestration";
  if (normalized.includes("apps/agent-runtime/src/runtime/")) return "module:runtime";
  if (normalized.includes("apps/agent-runtime/src/memory/")) return "module:memory";
  if (normalized.includes("swarm")) return "module:swarm";
  if (normalized.includes("apps/desktop/src-tauri/")) return "module:desktop-rust";
  if (normalized.includes("apps/desktop/src/")) return "module:desktop-ui";
  if (normalized.includes("packages/protocol/")) return "module:protocol";
  const parts = normalized.split("/");
  if (parts[0] === "apps" && parts[1]) return `module:${parts[1]}` as ModuleLockKey;
  if (parts[0] === "packages" && parts[1]) return `module:${parts[1]}` as ModuleLockKey;
  return undefined;
}

function semanticMatchesFile(key: string, file: string) {
  const normalized = file.toLowerCase();
  if (key.includes("database-schema")) return /metadata|sqlite|schema|migration/.test(normalized);
  if (key.includes("prompt-system")) return /prompt/.test(normalized);
  if (key.includes("validation-runner")) return /validation/.test(normalized);
  if (key.includes("lock-manager")) return /lock/.test(normalized);
  if (key.includes("project-config")) return /package|cargo|tsconfig|vite|tauri/.test(normalized);
  return normalized.includes(key.replace("semantic:", ""));
}

function uniqueScopes(scopes: FactoryLockScope[]) {
  const seen = new Set<string>();
  return scopes.filter((scope) => {
    const key = `${scope.type}:${scope.mode}:${scope.normalized_scope_key}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}
