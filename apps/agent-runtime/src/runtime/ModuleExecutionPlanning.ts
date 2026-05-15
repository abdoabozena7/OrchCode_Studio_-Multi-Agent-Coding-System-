import path from "node:path";
import type {
  AgentRuntimeSession,
  ModuleExecutionPlan,
  ModuleExecutionSummary,
  ModuleScopeValidation,
  PatchProposal,
  ProjectContextPack,
  ProjectIntake,
  VerificationResult
} from "@orchcode/protocol";
import type { WorkspaceTools } from "../tools/WorkspaceTools.js";

type ModulePlanInput = {
  sessionId: string;
  workspaceRoot: string;
  objective: string;
  createdAt: string;
  intake: ProjectIntake;
  contextPack?: ProjectContextPack;
  targetFiles: string[];
  suggestedCommands: string[];
};

export function buildModuleExecutionPlan(input: ModulePlanInput): ModuleExecutionPlan {
  const scopedTargets = input.targetFiles.filter((file) => !isPlaceholderPlanningFile(file));
  const relevantFiles = uniqueStrings([
    ...(input.contextPack?.relevantFiles ?? []),
    ...scopedTargets,
    ...input.intake.importantFiles.slice(0, 4)
  ]).slice(0, 10);
  const ownedPaths = uniqueStrings([
    ...relevantFiles,
    ...(input.contextPack?.safeToEdit ?? [])
  ]).slice(0, 10);
  const allowedPaths = uniqueStrings([
    ...ownedPaths,
    ...deriveAllowedRoots(relevantFiles)
  ]).slice(0, 12);
  const cautionPaths = uniqueStrings([
    ...(input.contextPack?.cautionPaths ?? []),
    ...input.intake.riskyFiles
  ]).slice(0, 10);
  const forbiddenPaths = uniqueStrings([
    ...(input.contextPack?.doNotTouchCandidates ?? []),
    ...input.intake.doNotTouchCandidates,
    "tauri://rust-authority",
    "workspace://outside-current"
  ]);
  const verificationCommands = uniqueStrings([
    ...(input.contextPack?.verificationCommands ?? []),
    ...input.suggestedCommands,
    ...input.intake.testCommands
  ]).slice(0, 6);
  const acceptanceCriteria = input.contextPack?.acceptanceCriteriaDraft?.length
    ? input.contextPack.acceptanceCriteriaDraft
    : [
        "Keep edits inside the scoped module plan.",
        "Preserve existing public contracts and patterns.",
        "Run verification before claiming completion."
      ];
  const publicContractsToPreserve = uniqueStrings([
    ...(input.contextPack?.apisLikelyToPreserve ?? []),
    ...relevantFiles.filter((file) => /(api|interface|types|schema|protocol)/i.test(file))
  ]).slice(0, 8);
  const requiredExistingPatterns = uniqueStrings([
    ...(input.contextPack?.conventionsDiscovered ?? []),
    "Prefer modifying existing files over creating parallel systems.",
    "Keep edits narrow after read-wide intake."
  ]).slice(0, 8);
  const risks = uniqueStrings([
    ...(input.contextPack?.knownRisks ?? []),
    ...input.intake.warnings,
    ...input.intake.unknowns
  ]).slice(0, 8);
  const unknowns = uniqueStrings([
    ...(input.contextPack?.unknowns ?? []),
    ...input.intake.unknowns
  ]).slice(0, 8);
  const approvalRequiredReasons = [
    "Existing-project continuation stays review-gated before apply.",
    "Any caution-path, dependency, deletion, or public-contract change requires explicit review."
  ];
  const title = inferPlanTitle(input.objective, relevantFiles);
  return {
    id: `module_plan_${slugify(title)}_${Date.now()}`,
    sessionId: input.sessionId,
    projectId: input.intake.projectId,
    workspaceRoot: input.workspaceRoot,
    source: input.intake.nextActionRecommendation ? "inferred_from_intake" : "unknown",
    status: "ready",
    title,
    objective: input.objective,
    rationale: input.intake.nextActionRecommendation ?? "Continue existing work conservatively using the context pack.",
    linkedIntakeId: input.intake.projectId,
    linkedContextPackId: input.intake.projectId ? `${input.intake.projectId}:context_pack` : undefined,
    targetModuleName: inferTargetModuleName(relevantFiles),
    relevantFiles,
    ownedPaths,
    allowedPaths,
    cautionPaths,
    forbiddenPaths,
    expectedNewFiles: [],
    disallowedNewFiles: forbiddenPaths.filter((value) => value.endsWith("/")),
    requiredExistingPatterns,
    publicContractsToPreserve,
    acceptanceCriteria,
    verificationCommands,
    risks,
    unknowns,
    stopConditions: [
      "Stop if the change requires files outside the owned or allowed paths.",
      "Stop if the scope grows into architecture rewrite, broad rename, or dependency expansion without approval.",
      "Stop if verification cannot be selected from the scoped command list."
    ],
    approvalRequiredReasons,
    createdAt: input.createdAt,
    updatedAt: input.createdAt
  };
}

export function validatePatchAgainstModulePlan(
  modulePlan: ModuleExecutionPlan,
  patch: PatchProposal,
  workspace?: WorkspaceTools
): ModuleScopeValidation {
  const allowedChanges: string[] = [];
  const cautionChanges: string[] = [];
  const forbiddenChanges: string[] = [];
  const unexpectedNewFiles: string[] = [];
  const deletionOrRenameConcerns: string[] = [];
  const dependencyConcerns: string[] = [];
  const publicContractConcerns: string[] = [];
  const reasons: string[] = [];

  for (const file of patch.filesChanged) {
    const filePath = normalizePath(file.path);
    if (matchesAnyPath(filePath, modulePlan.forbiddenPaths)) {
      forbiddenChanges.push(file.path);
      continue;
    }
    if (matchesAnyPath(filePath, modulePlan.cautionPaths)) {
      cautionChanges.push(file.path);
    } else if (matchesAnyPath(filePath, modulePlan.ownedPaths) || matchesAnyPath(filePath, modulePlan.allowedPaths)) {
      allowedChanges.push(file.path);
    } else {
      forbiddenChanges.push(file.path);
    }

    if (file.changeType === "create" && !isExpectedNewFile(file.path, modulePlan)) {
      unexpectedNewFiles.push(file.path);
    }
    if (file.changeType === "delete") {
      deletionOrRenameConcerns.push(`Delete detected: ${file.path}`);
    }
    if (
      file.changeType !== "modify" &&
      modulePlan.publicContractsToPreserve.some((contract) => normalizePath(contract) === filePath || filePath.includes(normalizePath(path.basename(contract))))
    ) {
      publicContractConcerns.push(`Public contract touched: ${file.path}`);
    }
  }

  dependencyConcerns.push(...detectDependencyConcerns(patch, workspace));
  if (forbiddenChanges.length) {
    reasons.push(`Out-of-scope change(s): ${forbiddenChanges.join(", ")}`);
  }
  if (cautionChanges.length) {
    reasons.push(`Caution path change(s): ${cautionChanges.join(", ")}`);
  }
  if (unexpectedNewFiles.length) {
    reasons.push(`Unexpected new file(s): ${unexpectedNewFiles.join(", ")}`);
  }
  if (deletionOrRenameConcerns.length) {
    reasons.push(...deletionOrRenameConcerns);
  }
  if (dependencyConcerns.length) {
    reasons.push(...dependencyConcerns);
  }
  if (publicContractConcerns.length) {
    reasons.push(...publicContractConcerns);
  }

  const verdict =
    forbiddenChanges.length || deletionOrRenameConcerns.some((concern) => /delete/i.test(concern) && publicContractConcerns.length > 0)
      ? "blocked"
      : cautionChanges.length || unexpectedNewFiles.length || deletionOrRenameConcerns.length || dependencyConcerns.length || publicContractConcerns.length
        ? "needs_review"
        : "in_scope";

  if (verdict === "in_scope" && !allowedChanges.length && patch.filesChanged.length) {
    reasons.push("Patch changes could not be proven inside owned or allowed paths.");
  }

  return {
    allowedChanges,
    cautionChanges,
    forbiddenChanges,
    unexpectedNewFiles,
    deletionOrRenameConcerns,
    dependencyConcerns,
    publicContractConcerns,
    verdict: verdict === "in_scope" && !allowedChanges.length && patch.filesChanged.length ? "blocked" : verdict,
    reasons: verdict === "in_scope" && !allowedChanges.length && patch.filesChanged.length
      ? [...reasons, "Unknown scope classification defaults to blocked."]
      : reasons
  };
}

export function summarizeModuleExecution(
  session: AgentRuntimeSession,
  verification: VerificationResult | undefined
): ModuleExecutionSummary | undefined {
  const modulePlan = session.moduleExecutionPlan;
  if (!modulePlan) return undefined;
  const status =
    session.status === "completed"
      ? "complete"
      : session.status === "failed"
        ? "failed"
        : session.reviewGate?.scopeValidation?.verdict === "blocked"
          ? "blocked"
          : session.status === "needs_approval"
            ? "partial"
            : "needs_follow_up";
  const checks = verification?.checks ?? [];
  const completedAcceptanceCriteria = status === "complete"
    ? modulePlan.acceptanceCriteria
    : modulePlan.acceptanceCriteria.filter((_criterion, index) => index < Math.max(1, Math.floor(modulePlan.acceptanceCriteria.length / 2)));
  const failedAcceptanceCriteria = status === "complete" ? [] : modulePlan.acceptanceCriteria.filter((criterion) => !completedAcceptanceCriteria.includes(criterion));
  return {
    id: `module_summary_${modulePlan.id}`,
    sessionId: session.id,
    modulePlanId: modulePlan.id,
    title: modulePlan.title,
    status,
    completedAcceptanceCriteria,
    failedAcceptanceCriteria,
    changedFiles: session.patchProposals.flatMap((patch) => patch.filesChanged.map((file) => file.path)),
    verificationResults: checks.map((check) => ({
      name: check.name,
      status: check.status,
      detail: check.detail
    })),
    remainingRisks: uniqueStrings([
      ...(session.reviewGate?.scopeValidation?.reasons ?? []),
      ...(modulePlan.risks ?? [])
    ]).slice(0, 8),
    nextRecommendedAction: session.runSummary?.nextAction ?? session.projectIntake?.nextActionRecommendation,
    scopeVerdict: session.reviewGate?.scopeValidation?.verdict,
    summary:
      status === "complete"
        ? "Scoped module execution completed with verification."
        : status === "blocked"
          ? "Scoped module execution was blocked by scope or review guardrails."
          : status === "failed"
            ? "Scoped module execution failed before verification passed."
            : "Scoped module execution is partial and needs follow-up.",
    createdAt: session.updatedAt,
    updatedAt: session.updatedAt
  };
}

function inferPlanTitle(objective: string, relevantFiles: string[]) {
  const file = relevantFiles[0];
  if (file) return `Scoped continuation for ${path.basename(file)}`;
  return `Scoped continuation for ${objective.slice(0, 48)}`;
}

function inferTargetModuleName(relevantFiles: string[]) {
  const file = relevantFiles[0];
  if (!file) return undefined;
  const [root, next] = file.split("/");
  return next ? `${root}/${next}` : root;
}

function deriveAllowedRoots(files: string[]) {
  return uniqueStrings(
    files.map((file) => {
      const parts = normalizePath(file).split("/");
      return parts.length > 1 ? `${parts[0]}/${parts[1]}` : parts[0] ?? file;
    })
  );
}

function isExpectedNewFile(filePath: string, modulePlan: ModuleExecutionPlan) {
  return (
    matchesAnyPath(filePath, modulePlan.expectedNewFiles) ||
    matchesAnyPath(filePath, modulePlan.allowedPaths) ||
    matchesAnyPath(filePath, modulePlan.ownedPaths)
  );
}

function detectDependencyConcerns(patch: PatchProposal, workspace?: WorkspaceTools) {
  const concerns: string[] = [];
  for (const artifact of patch.artifacts ?? []) {
    if (artifact.path === "package.json") {
      concerns.push(...detectPackageJsonDependencyConcerns(artifact.content, workspace));
    }
    if (artifact.path === "Cargo.toml") {
      concerns.push(...detectCargoDependencyConcerns(artifact.content, workspace));
    }
  }
  return concerns;
}

function detectPackageJsonDependencyConcerns(afterContent: string, workspace?: WorkspaceTools) {
  const concerns: string[] = [];
  const beforeContent = workspace?.fileExists("package.json") ? safeReadWholeFile(workspace, "package.json") : undefined;
  try {
    const after = JSON.parse(afterContent) as Record<string, unknown>;
    const before = beforeContent ? JSON.parse(beforeContent) as Record<string, unknown> : {};
    for (const key of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const) {
      const nextDeps = objectKeys(after[key]);
      const previousDeps = objectKeys(before[key]);
      const added = nextDeps.filter((dependency) => !previousDeps.includes(dependency));
      if (added.length) {
        concerns.push(`Dependency review required: ${key} adds ${added.join(", ")}.`);
      }
    }
  } catch {
    concerns.push("Dependency review required: package.json changed but dependency diff could not be parsed confidently.");
  }
  return concerns;
}

function detectCargoDependencyConcerns(afterContent: string, workspace?: WorkspaceTools) {
  const beforeContent = workspace?.fileExists("Cargo.toml") ? safeReadWholeFile(workspace, "Cargo.toml") : "";
  const afterDependencies = extractCargoDependencyNames(afterContent);
  const beforeDependencies = extractCargoDependencyNames(beforeContent ?? "");
  const added = afterDependencies.filter((dependency) => !beforeDependencies.includes(dependency));
  return added.length ? [`Dependency review required: Cargo.toml adds ${added.join(", ")}.`] : [];
}

function extractCargoDependencyNames(content: string) {
  const lines = content.split(/\r?\n/);
  const names: string[] = [];
  let inDependencies = false;
  for (const line of lines) {
    if (/^\s*\[.*\]\s*$/.test(line)) {
      inDependencies = /^\s*\[(dev-)?dependencies\]\s*$/.test(line);
      continue;
    }
    if (!inDependencies) continue;
    const match = line.match(/^\s*([A-Za-z0-9_-]+)\s*=/);
    if (match?.[1]) names.push(match[1]);
  }
  return uniqueStrings(names);
}

function safeReadWholeFile(workspace: WorkspaceTools, filePath: string) {
  try {
    return workspace.readWholeFile(filePath);
  } catch {
    return undefined;
  }
}

function objectKeys(value: unknown) {
  return value && typeof value === "object" ? Object.keys(value as Record<string, unknown>) : [];
}

function matchesAnyPath(filePath: string, patterns: string[]) {
  const normalized = normalizePath(filePath);
  return patterns.some((pattern) => {
    const candidate = normalizePath(pattern);
    if (!candidate) return false;
    const bare = candidate.replace(/\/$/, "");
    return normalized === bare || normalized.startsWith(`${bare}/`);
  });
}

function normalizePath(value: string) {
  return value.replaceAll("\\", "/").replace(/^\.\/+/, "");
}

function slugify(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function isPlaceholderPlanningFile(filePath: string) {
  return /(^|\/)AGENT_PROPOSAL\.md$/i.test(filePath);
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}
