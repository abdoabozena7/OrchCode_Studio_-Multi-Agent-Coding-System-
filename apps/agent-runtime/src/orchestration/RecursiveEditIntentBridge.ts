import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import type { PatchProposal, PatchRiskLevel, CommandRequest, CommandRisk } from "@hivo/protocol";
import type { EditIntent, GeneratedArtifact, ValidationPlan, RecursiveSwarmNode, MemoryEvidencePack } from "./RecursiveSwarmModels.js";
import { classifyCommandRisk } from "../tools/CommandPolicy.js";
import { buildSurgicalPatch, type SurgicalPatchInput } from "./SurgicalPatchBuilder.js";
import { evaluateEditIntentQuality, type EditIntentQualityResult } from "./EditIntentQualityGate.js";
import { expandEditIntent, type EvidenceExpansionResult } from "./EvidenceExpansionLoop.js";

export const MAX_EXPANSION_ATTEMPTS = 2;

// ── Types ───────────────────────────────────────────────────

export type BridgeEditIntent = {
  nodeId: string;
  intent: EditIntent;
};

export type BridgeGeneratedArtifact = {
  nodeId: string;
  artifact: GeneratedArtifact;
};

export type BlockedEditIntent = {
  nodeId: string;
  intent: EditIntent;
  reason: string;
};

export type NeedsGenerationIntent = {
  nodeId: string;
  intent: EditIntent;
  reason: string;
  requiredEvidence: string[];
};

export type BridgeResult = {
  patchCandidates: PatchProposal[];
  blockedIntents: BlockedEditIntent[];
  needsGenerationIntents: NeedsGenerationIntent[];
  diagnostics: string[];
  validationCommandRequests: CommandRequest[];
  summaryCounts: {
    realDiff: number;
    needsGeneration: number;
    blocked: number;
  };
  /** New quality/expansion metrics */
  qualityMetrics: {
    totalIntents: number;
    readyOnFirstPass: number;
    expandedSuccessfully: number;
    expansionFailed: number;
    blockedByQualityGate: number;
    blockedByPatchBuilder: number;
    topMissingFields: string[];
    contextSourceSummary: string;
  };
};

export type BridgeInput = {
  sessionId: string;
  workspacePath: string;
  intents: BridgeEditIntent[];
  generatedArtifacts?: BridgeGeneratedArtifact[];
  validationPlans: { nodeId: string; plan: ValidationPlan }[];
  allowedPaths: string[];
  forbiddenPaths: string[];
  fileContents?: Record<string, string>;
  builderOverrides?: Record<string, Pick<SurgicalPatchInput, "exactOldText" | "replacementText" | "anchorLine" | "insertAfterAnchor" | "insertBeforeAnchor">>;
  evidencePacks?: Record<string, MemoryEvidencePack>;
};

// ── Helpers ─────────────────────────────────────────────────

function mapRisk(risk: EditIntent["risk"]): PatchRiskLevel {
  if (risk === "low") return "low";
  if (risk === "medium") return "medium";
  return "high";
}

function mapChangeType(operation: EditIntent["operation"]): "create" | "modify" | "delete" {
  if (operation === "create") return "create";
  if (operation === "delete") return "delete";
  return "modify";
}

function copyOverrides(src: BridgeInput["builderOverrides"] | undefined, file: string) {
  const o = src?.[file];
  return o ? { exactOldText: o.exactOldText, replacementText: o.replacementText, anchorLine: o.anchorLine, insertAfterAnchor: o.insertAfterAnchor, insertBeforeAnchor: o.insertBeforeAnchor } : undefined;
}

type GeneratedArtifactPatchResult = {
  proposal?: PatchProposal;
  blockedReason?: string;
  needsGenerationReason?: string;
  diagnostics: string[];
};

function buildGeneratedArtifactPatch(input: {
  sessionId: string;
  workspacePath: string;
  nodeId: string;
  artifact: GeneratedArtifact;
  allowedPaths: string[];
  forbiddenPaths: string[];
  existingContent?: string;
}): GeneratedArtifactPatchResult {
  const diagnostics: string[] = [];
  const targetPath = normalizeArtifactPath(input.artifact.path);
  if (!targetPath) {
    return { blockedReason: `Generated artifact path is unsafe: ${input.artifact.path}`, diagnostics: ["Generated artifact blocked: unsafe path"] };
  }
  if (!isGeneratedPathAllowed(targetPath, input.allowedPaths)) {
    return { blockedReason: `Generated artifact path is not in allowed paths: ${targetPath}`, diagnostics: [`Generated artifact blocked: ${targetPath} not allowed`] };
  }
  if (isGeneratedPathForbidden(targetPath, input.forbiddenPaths) || isGeneratedSecretPath(targetPath)) {
    return { blockedReason: `Generated artifact path is forbidden or sensitive: ${targetPath}`, diagnostics: [`Generated artifact blocked: ${targetPath} forbidden/sensitive`] };
  }
  const workspaceRoot = path.resolve(input.workspacePath || ".");
  const resolvedTarget = path.resolve(workspaceRoot, targetPath);
  if (resolvedTarget !== workspaceRoot && !resolvedTarget.startsWith(`${workspaceRoot}${path.sep}`)) {
    return { blockedReason: `Generated artifact escapes workspace: ${targetPath}`, diagnostics: [`Generated artifact blocked: ${targetPath} escapes workspace`] };
  }
  const content = input.artifact.content;
  if (!content.trim()) {
    return { needsGenerationReason: `Generated artifact ${targetPath} has empty content`, diagnostics: [`Generated artifact needs generation: ${targetPath} empty content`] };
  }
  if (Buffer.byteLength(content, "utf8") > 1_000_000) {
    return { needsGenerationReason: `Generated artifact ${targetPath} is too large to propose safely`, diagnostics: [`Generated artifact needs generation: ${targetPath} too large`] };
  }
  const knownExistingContent = input.existingContent ?? "";
  if (knownExistingContent.trim().length > 0 || existsSync(resolvedTarget)) {
    return { blockedReason: `Generated artifact target already exists: ${targetPath}`, diagnostics: [`Generated artifact blocked: ${targetPath} already exists`] };
  }

  const lines = content.split("\n");
  const unifiedDiff = [
    "--- /dev/null",
    `+++ b/${targetPath}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`)
  ].join("\n") + "\n";
  const now = new Date().toISOString();
  const proposal: PatchProposal = {
    id: `rs_artifact_${randomUUID().slice(0, 8)}`,
    sessionId: input.sessionId,
    title: `create ${targetPath}`,
    summary: `Generated artifact from recursive swarm node ${input.nodeId}: ${input.artifact.description.slice(0, 220)}`,
    riskLevel: input.artifact.confidence >= 0.75 ? "medium" : "high",
    filesChanged: [{
      path: targetPath,
      changeType: "create",
      explanation: input.artifact.description.slice(0, 220)
    }],
    artifacts: [
      { path: targetPath, content },
      { path: "_generated_artifact_node", content: input.nodeId },
      { path: "_generated_artifact_validation", content: input.artifact.validation_steps.join("\n") },
      { path: "_generated_artifact_notes", content: input.artifact.completeness_notes.join("\n") }
    ],
    unifiedDiff,
    requiresApproval: true,
    status: "proposed",
    createdAt: now
  };
  diagnostics.push(`Generated artifact patch proposed for ${targetPath} (${content.length} character(s), ${lines.length} line(s))`);
  return { proposal, diagnostics };
}

function generatedArtifactToIntent(artifact: GeneratedArtifact): EditIntent {
  return {
    kind: "edit_intent",
    target_file: normalizeArtifactPath(artifact.path) ?? artifact.path,
    target_symbol_or_range: "full file",
    operation: "create",
    reason: artifact.description,
    expected_behavior: artifact.completeness_notes.join("; "),
    risk: artifact.confidence >= 0.75 ? "medium" : "high",
    evidence_refs: []
  };
}

function normalizeArtifactPath(value: string): string | null {
  const normalized = value.trim().replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized || path.isAbsolute(normalized) || normalized.startsWith("/") || normalized.split("/").includes("..")) return null;
  return normalized;
}

function isGeneratedPathAllowed(filePath: string, allowed: string[]): boolean {
  if (allowed.length === 0) return true;
  return allowed.some((prefix) => filePath.startsWith(prefix));
}

function isGeneratedPathForbidden(filePath: string, forbidden: string[]): boolean {
  return forbidden.some((prefix) => filePath.startsWith(prefix));
}

function isGeneratedSecretPath(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return [".env", ".pem", ".key", ".cert", "credentials", "secrets/", "node_modules/"]
    .some((secret) => lower.includes(secret));
}

// ── Main bridge ─────────────────────────────────────────────

export function bridgeEditIntents(input: BridgeInput): BridgeResult {
  const { sessionId, workspacePath, intents, generatedArtifacts = [], validationPlans, allowedPaths, forbiddenPaths, fileContents, builderOverrides, evidencePacks } = input;

  const patchCandidates: PatchProposal[] = [];
  const blockedIntents: BlockedEditIntent[] = [];
  const needsGenerationIntents: NeedsGenerationIntent[] = [];
  const diagnostics: string[] = [];
  const now = new Date().toISOString();

  // Quality/expansion metrics
  const metricAllMissingFields = new Map<string, number>();
  let metricReadyFirstPass = 0;
  let metricExpandedOk = 0;
  let metricExpandedFail = 0;
  let metricBlockedByQuality = 0;
  let metricBlockedByBuilder = 0;

  // Group intents by target file for conflict detection
  const fileIntentMap = new Map<string, BridgeEditIntent[]>();
  for (const item of intents) {
    const existing = fileIntentMap.get(item.intent.target_file) ?? [];
    existing.push(item);
    fileIntentMap.set(item.intent.target_file, existing);
  }

  // Detect same-file conflicts
  for (const [file, items] of fileIntentMap) {
    if (items.length > 1) {
      const ops = items.map((i) => i.intent.operation).join(", ");
      diagnostics.push(`Conflict detected on ${file}: ${items.length} intents (${ops}) — processing separately`);
    }
  }

  // Process each intent through quality gate → (optional expansion) → patch builder
  for (const [, items] of fileIntentMap) {
    for (const item of items) {
      let currentIntent = { ...item.intent };
      let currentOverrides = copyOverrides(builderOverrides, currentIntent.target_file);
      const nodeId = item.nodeId;
      const evidencePack = evidencePacks?.[nodeId];
      const contextSource = evidencePack?.context_source;

      let expansionAttempts = 0;
      let finalResult: "proposal" | "needs_generation" | "blocked" | null = null;

      while (finalResult === null && expansionAttempts <= MAX_EXPANSION_ATTEMPTS) {
        // Quality gate
        const qualityResult = evaluateEditIntentQuality({
          editIntent: currentIntent,
          evidencePack,
          allowedPaths,
          forbiddenPaths,
          builderOverrides: currentOverrides,
          contextSource
        });
        diagnostics.push(...qualityResult.diagnostics);
        for (const f of qualityResult.missingFields) {
          metricAllMissingFields.set(f, (metricAllMissingFields.get(f) ?? 0) + 1);
        }

        switch (qualityResult.status) {
          case "ready_for_patch": {
            if (expansionAttempts === 0) metricReadyFirstPass++;
            // Run SurgicalPatchBuilder
            const currentFileContent = fileContents?.[currentIntent.target_file] ?? "";
            const builderInput: SurgicalPatchInput = {
              editIntent: currentIntent,
              evidencePack,
              workspacePath,
              currentFileContent,
              allowedPaths,
              forbiddenPaths,
              exactOldText: currentOverrides?.exactOldText,
              replacementText: currentOverrides?.replacementText,
              anchorLine: currentOverrides?.anchorLine,
              insertAfterAnchor: currentOverrides?.insertAfterAnchor,
              insertBeforeAnchor: currentOverrides?.insertBeforeAnchor
            };
            const buildResult = buildSurgicalPatch(builderInput);
            diagnostics.push(...buildResult.diagnostics);

            if (buildResult.status === "real_diff") {
              const proposal: PatchProposal = {
                id: buildResult.patchCandidateId,
                sessionId,
                title: `${currentIntent.operation} ${currentIntent.target_file}`,
                summary: buildResult.summary,
                riskLevel: mapRisk(buildResult.risk),
                filesChanged: [{
                  path: currentIntent.target_file,
                  changeType: mapChangeType(currentIntent.operation),
                  explanation: currentIntent.reason.slice(0, 200)
                }],
                artifacts: [
                  { path: "_edit_intent_id", content: currentIntent.target_file },
                  { path: "_evidence_refs", content: buildResult.evidenceRefs.join(", ") },
                  { path: "_builder_summary", content: buildResult.summary }
                ],
                unifiedDiff: buildResult.unifiedDiff,
                requiresApproval: true,
                status: "proposed",
                createdAt: now
              };
              patchCandidates.push(proposal);
              finalResult = "proposal";
            } else if (buildResult.status === "blocked") {
              metricBlockedByBuilder++;
              blockedIntents.push({ nodeId, intent: currentIntent, reason: buildResult.reason });
              finalResult = "blocked";
            } else {
              // needs_patch_generation from builder
              needsGenerationIntents.push({
                nodeId,
                intent: currentIntent,
                reason: buildResult.reason,
                requiredEvidence: buildResult.requiredEvidence
              });
              finalResult = "needs_generation";
            }
            break;
          }

          case "blocked": {
            metricBlockedByQuality++;
            blockedIntents.push({ nodeId, intent: currentIntent, reason: qualityResult.diagnostics.join("; ") });
            finalResult = "blocked";
            break;
          }

          case "needs_user_or_planner_clarification": {
            needsGenerationIntents.push({
              nodeId,
              intent: currentIntent,
              reason: qualityResult.diagnostics.join("; "),
              requiredEvidence: qualityResult.requiredEvidence
            });
            finalResult = "needs_generation";
            break;
          }

          case "needs_evidence_expansion": {
            if (expansionAttempts >= MAX_EXPANSION_ATTEMPTS) {
              metricExpandedFail++;
              needsGenerationIntents.push({
                nodeId,
                intent: currentIntent,
                reason: `Evidence expansion exhausted (${MAX_EXPANSION_ATTEMPTS} attempt(s)): ${qualityResult.diagnostics.join("; ")}`,
                requiredEvidence: qualityResult.requiredEvidence
              });
              finalResult = "needs_generation";
              break;
            }
            expansionAttempts++;

            const expansionResult = expandEditIntent({
              editIntent: currentIntent,
              evidencePack,
              workspacePath,
              allowedPaths,
              forbiddenPaths,
              fileContents,
              existingOverrides: currentOverrides
            });
            diagnostics.push(...expansionResult.diagnostics);

            if (expansionResult.status === "expanded") {
              metricExpandedOk++;
              currentIntent = expansionResult.refinedEditIntent;
              currentOverrides = expansionResult.builderOverrides;
              // Loop to re-check quality gate
            } else if (expansionResult.status === "blocked") {
              metricBlockedByQuality++;
              blockedIntents.push({
                nodeId,
                intent: currentIntent,
                reason: expansionResult.diagnostics.join("; ")
              });
              finalResult = "blocked";
            } else {
              metricExpandedFail++;
              needsGenerationIntents.push({
                nodeId,
                intent: currentIntent,
                reason: `Evidence expansion not found: ${expansionResult.diagnostics.join("; ")}`,
                requiredEvidence: qualityResult.requiredEvidence
              });
              finalResult = "needs_generation";
            }
            break;
          }
        }
      }
    }
  }

  for (const item of generatedArtifacts) {
    const result = buildGeneratedArtifactPatch({
      sessionId,
      workspacePath,
      nodeId: item.nodeId,
      artifact: item.artifact,
      allowedPaths,
      forbiddenPaths,
      existingContent: fileContents?.[item.artifact.path]
    });
    diagnostics.push(...result.diagnostics);
    if (result.proposal) {
      patchCandidates.push(result.proposal);
    } else if (result.blockedReason) {
      blockedIntents.push({
        nodeId: item.nodeId,
        intent: generatedArtifactToIntent(item.artifact),
        reason: result.blockedReason
      });
    } else {
      needsGenerationIntents.push({
        nodeId: item.nodeId,
        intent: generatedArtifactToIntent(item.artifact),
        reason: result.needsGenerationReason ?? "Generated artifact could not be converted to a patch.",
        requiredEvidence: [item.artifact.path]
      });
    }
  }

  // Handle validation commands
  const validationCommandRequests: CommandRequest[] = [];
  for (const vp of validationPlans) {
    for (const cmd of vp.plan.commands) {
      const risk: CommandRisk = classifyCommandRisk(cmd, workspacePath);
      const cmdReq: CommandRequest = {
        id: `rs_valcmd_${randomUUID().slice(0, 8)}`,
        sessionId,
        command: cmd,
        cwd: workspacePath,
        risk,
        reason: `Validation command from recursive swarm node ${vp.nodeId}: ${vp.plan.smoke_checks.join("; ").slice(0, 200)}`,
        status: "requested",
        createdAt: now
      };
      validationCommandRequests.push(cmdReq);
    }
    if (vp.plan.blockers.length > 0) {
      diagnostics.push(`Node ${vp.nodeId} has ${vp.plan.blockers.length} blockers: ${vp.plan.blockers.join("; ")}`);
    }
  }

  const summaryCounts = {
    realDiff: patchCandidates.length,
    needsGeneration: needsGenerationIntents.length,
    blocked: blockedIntents.length
  };

  // Top missing fields (sorted by frequency)
  const topMissingFields = [...metricAllMissingFields.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([field]) => field);

  // Context source summary
  const contextCounts: Record<string, number> = {};
  for (const item of intents) {
    const pack = evidencePacks?.[item.nodeId];
    const cs = pack?.context_source ?? "unknown";
    contextCounts[cs] = (contextCounts[cs] ?? 0) + 1;
  }
  const contextSourceSummary = Object.entries(contextCounts)
    .map(([k, v]) => `${v}×${k}`)
    .join(", ") || "unknown";

  const qualityMetrics = {
    totalIntents: intents.length,
    readyOnFirstPass: metricReadyFirstPass,
    expandedSuccessfully: metricExpandedOk,
    expansionFailed: metricExpandedFail,
    blockedByQualityGate: metricBlockedByQuality,
    blockedByPatchBuilder: metricBlockedByBuilder,
    topMissingFields,
    contextSourceSummary
  };

  diagnostics.push(
    `Bridge result: ${summaryCounts.realDiff} real diff(s), ` +
    `${summaryCounts.needsGeneration} need(s) generation, ` +
    `${summaryCounts.blocked} blocked, ` +
    `${validationCommandRequests.length} validation command(s). ` +
    `Quality: ${metricReadyFirstPass} ready, ${metricExpandedOk} expanded, ${metricExpandedFail} expansion fail.`
  );

  return { patchCandidates, blockedIntents, needsGenerationIntents, diagnostics, validationCommandRequests, summaryCounts, qualityMetrics };
}

/** Scan all nodes in a RecursiveSwarmTree for EditIntent and ValidationPlan outputs. */
export function collectIntentsFromTree(
  nodes: Record<string, Pick<RecursiveSwarmNode, "id" | "structuredOutput">>
): {
  intents: BridgeEditIntent[];
  generatedArtifacts: BridgeGeneratedArtifact[];
  validationPlans: { nodeId: string; plan: ValidationPlan }[];
} {
  const intents: BridgeEditIntent[] = [];
  const generatedArtifacts: BridgeGeneratedArtifact[] = [];
  const validationPlans: { nodeId: string; plan: ValidationPlan }[] = [];

  for (const node of Object.values(nodes)) {
    if (!node.structuredOutput) continue;
    const output = node.structuredOutput;
    if (output.kind === "edit_intent") {
      intents.push({ nodeId: node.id, intent: output as EditIntent });
    } else if (output.kind === "generated_artifact") {
      generatedArtifacts.push({ nodeId: node.id, artifact: output as GeneratedArtifact });
    } else if (output.kind === "validation_plan") {
      validationPlans.push({ nodeId: node.id, plan: output as ValidationPlan });
    } else if (output.kind === "final_summary") {
      const fs = output;
      for (const ei of fs.edit_intents) {
        intents.push({ nodeId: node.id, intent: ei });
      }
      for (const vp of fs.validation_plans) {
        validationPlans.push({ nodeId: node.id, plan: vp });
      }
    }
  }

  return { intents, generatedArtifacts, validationPlans };
}
