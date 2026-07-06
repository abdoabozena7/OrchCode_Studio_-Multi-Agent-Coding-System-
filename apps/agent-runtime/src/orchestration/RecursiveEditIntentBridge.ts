import { randomUUID } from "node:crypto";
import type { PatchProposal, PatchRiskLevel, CommandRequest, CommandRisk } from "@hivo/protocol";
import type { EditIntent, ValidationPlan, RecursiveSwarmNode, MemoryEvidencePack } from "./RecursiveSwarmModels.js";
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

// ── Main bridge ─────────────────────────────────────────────

export function bridgeEditIntents(input: BridgeInput): BridgeResult {
  const { sessionId, workspacePath, intents, validationPlans, allowedPaths, forbiddenPaths, fileContents, builderOverrides, evidencePacks } = input;

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
  validationPlans: { nodeId: string; plan: ValidationPlan }[];
} {
  const intents: BridgeEditIntent[] = [];
  const validationPlans: { nodeId: string; plan: ValidationPlan }[] = [];

  for (const node of Object.values(nodes)) {
    if (!node.structuredOutput) continue;
    const output = node.structuredOutput;
    if (output.kind === "edit_intent") {
      intents.push({ nodeId: node.id, intent: output as EditIntent });
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

  return { intents, validationPlans };
}
