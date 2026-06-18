import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type {
  ProviderAuthoredResult,
  ReasoningStep,
  TurnUnderstanding
} from "@hivo/protocol";
import type { LlmProvider, LlmRequest } from "../llm/LlmProvider.js";
import { userPromptWithContext } from "../llm/LlmProvider.js";
import { rebuildRepoIndex } from "../memory/RepoIndexer.js";
import { EvidenceStore } from "../runtime/EvidenceStore.js";
import { ReasoningKernelFailure, runAdaptiveReasoningTurn } from "../runtime/ReasoningKernel.js";
import { ReasoningToolDispatcher } from "../runtime/ReasoningToolDispatcher.js";
import { ToolRegistry } from "../tools/ToolRegistry.js";

test("adaptive reasoning executes provider-requested search and read tools before final answer", async () => {
  const workspace = await fixture();
  try {
    const provider = new AdaptiveProjectProvider();
    const result = await runAdaptiveReasoningTurn({
      provider,
      message: "Explain how the unusual beacon reaches the archive.",
      sessionId: "session_adaptive",
      tools: new ToolRegistry(workspace)
    });

    assert.equal(result.result.decision, "ANSWER");
    assert.equal(result.trace.toolRounds, 2);
    assert.deepEqual(result.trace.toolResults.map((entry) => entry.kind), ["repository_search", "read_file"]);
    assert.ok(result.trace.evidenceRefs.some((entry) => entry.path === "src/beacon.ts"));
    assert.ok(result.result.evidenceRefs.every((id) => result.trace.evidenceRefs.some((entry) => entry.id === id)));
    assert.deepEqual(provider.schemas, ["initial-reasoning-decision", "reasoning-step", "reasoning-step", "answer-verification"]);
    assert.equal(result.trace.verificationResults[0]?.verdict, "pass");
    assert.equal(result.trace.progress.length, 2);
    assert.ok(result.trace.progress.every((entry) => entry.informationGain > 0));
    assert.ok(result.trace.stageBudgets.some((entry) => entry.stage === "verify" && entry.maxOutputTokens === 1_024));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("final reasoning step may omit result and still uses provider compose", async () => {
  const workspace = await fixture();
  try {
    const provider = new FinalWithoutResultProvider();
    const result = await runAdaptiveReasoningTurn({
      provider,
      message: "Explain the beacon flow.",
      sessionId: "session_final_without_result",
      tools: new ToolRegistry(workspace)
    });

    assert.equal(result.result.decision, "ANSWER");
    assert.equal(result.result.answerMarkdown, FinalWithoutResultProvider.answer);
    assert.equal(result.trace.toolRounds, 1);
    assert.deepEqual(provider.schemas, [
      "initial-reasoning-decision",
      "reasoning-step",
      "provider-authored-result",
      "answer-verification"
    ]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("malformed provider claim objects are repaired instead of crashing validation", async () => {
  const workspace = await fixture();
  try {
    const provider = new MalformedClaimRepairProvider();
    const result = await runAdaptiveReasoningTurn({
      provider,
      message: "Explain the beacon flow.",
      sessionId: "session_malformed_claim_repair",
      tools: new ToolRegistry(workspace)
    });

    assert.equal(result.result.decision, "ANSWER");
    assert.ok(provider.schemas.filter((schema) => schema === "reasoning-step").length >= 2);
    assert.ok(result.trace.repairErrors.some((entry) => entry.kind === "malformed_result"));
    assert.equal(result.trace.verificationResults[0]?.verdict, "pass");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("investigate_project refreshes repository memory and returns a fact-only cross-file evidence bundle", async () => {
  const workspace = await fixture();
  try {
    const evidenceStore = new EvidenceStore();
    const dispatcher = new ReasoningToolDispatcher({
      sessionId: "session_investigate_project",
      tools: new ToolRegistry(workspace),
      evidenceStore
    });
    const result = await dispatcher.execute({
      id: "investigate_beacon",
      kind: "investigate_project",
      query: "how a travelling payload reaches its final archive",
      reason: "Resolve the cross-file flow without relying on an exact symbol name."
    });

    assert.equal(result.status, "success");
    assert.equal((result.data as { indexReadiness: { before: string; after: string; refreshed: boolean } }).indexReadiness.after, "fresh");
    assert.equal((result.data as { indexReadiness: { refreshed: boolean } }).indexReadiness.refreshed, true);
    assert.ok(result.evidenceRefs.some((entry) => entry.sourceType === "investigation_bundle"));
    assert.ok(result.evidenceRefs.some((entry) => entry.path === "src/beacon.ts"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("adaptive reasoning records command requests as approval-required instead of claiming execution", async () => {
  const workspace = await fixture();
  try {
    const provider = new CommandRequestProvider();
    const requests: string[] = [];
    const result = await runAdaptiveReasoningTurn({
      provider,
      message: "Run the tests.",
      sessionId: "session_command",
      tools: new ToolRegistry(workspace),
      onCommandRequest: async (request) => {
        requests.push(request.command);
      }
    });

    assert.deepEqual(requests, ["npm test"]);
    assert.equal(result.trace.toolResults[0]?.status, "approval_required");
    assert.equal(result.result.decision, "ESCALATE");
    assert.match(result.result.answerMarkdown, /approval/i);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("adaptive reasoning preserves provider-requested file listings in the next reasoning step", async () => {
  const workspace = await fixture();
  try {
    const provider = new ListingProvider();
    const result = await runAdaptiveReasoningTurn({
      provider,
      message: "Find the implementation without knowing its filename.",
      sessionId: "session_listing",
      tools: new ToolRegistry(workspace)
    });

    assert.equal(result.result.decision, "FOLLOW_UP");
    assert.equal(provider.sawBeaconPath, true);
    assert.equal(result.trace.toolResults[0]?.kind, "list_files");
    assert.ok(result.trace.toolResults[0]?.evidenceRefs.some((entry) => entry.sourceType === "workspace_listing"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("provider context overflow is explicit instead of silently truncated", () => {
  assert.throws(
    () => userPromptWithContext({
      systemPrompt: "system",
      userPrompt: "user",
      context: { evidence: "x".repeat(200) },
      maxContextChars: 100
    }),
    /provider\.context_too_large/
  );
});

test("adaptive reasoning performs an explicit provider curation round when evidence exceeds context", async () => {
  const workspace = await fixture();
  try {
    const paths: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      const filePath = `src/large-${index}.ts`;
      paths.push(filePath);
      await writeFile(path.join(workspace, filePath), `export const value${index} = "${"x".repeat(6_000)}";\n`, "utf8");
    }
    const provider = new CurationProvider(paths);
    const result = await runAdaptiveReasoningTurn({
      provider,
      message: "Compare the large source records.",
      sessionId: "session_curation",
      tools: new ToolRegistry(workspace)
    });

    assert.equal(result.result.decision, "ANSWER");
    assert.ok(provider.schemas.includes("evidence-curation"));
    assert.ok(provider.curationContextChars > 0);
    assert.ok(provider.curationContextChars < 12_000);
    assert.ok(result.trace.contextOmissions.length > 0);
    assert.ok(result.trace.contextOmissions.every((entry) => entry.omittedEvidenceIds.length > 0));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("provider compose receives bounded context after large tool results", async () => {
  const workspace = await fixture();
  try {
    const paths: string[] = [];
    for (let index = 0; index < 10; index += 1) {
      const filePath = `src/compose-large-${index}.ts`;
      paths.push(filePath);
      await writeFile(path.join(workspace, filePath), `export const composeValue${index} = "${"x".repeat(8_000)}";\n`, "utf8");
    }
    const provider = new BoundedComposeProvider(paths);
    const result = await runAdaptiveReasoningTurn({
      provider,
      message: "Summarize the large compose sources.",
      sessionId: "session_bounded_compose",
      tools: new ToolRegistry(workspace)
    });

    assert.equal(result.result.decision, "ANSWER");
    assert.ok(provider.composeContextChars > 0);
    assert.ok(provider.composeContextChars < 20_000);
    assert.ok(result.trace.contextOmissions.some((entry) => entry.stage === "compose"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("compose validation repair reuses provider result schema with bounded read-file evidence", async () => {
  const workspace = await fixture();
  try {
    await writeFile(
      path.join(workspace, "README.md"),
      "# Hivo Studio\n\nHivo Studio is an orchestration-first multi-agent coding system.\n",
      "utf8"
    );
    for (let index = 0; index < 70; index += 1) {
      await writeFile(
        path.join(workspace, "src", `noisy-${index}.ts`),
        `export const noisy${index} = "project-overview-noise-${index}";\n`,
        "utf8"
      );
    }
    const provider = new ComposeRepairProvider();
    const result = await runAdaptiveReasoningTurn({
      provider,
      message: "What is this project for?",
      sessionId: "session_compose_validation_repair",
      tools: new ToolRegistry(workspace)
    });

    assert.equal(result.result.decision, "ANSWER");
    assert.deepEqual(provider.schemas.filter((schema) => schema === "provider-authored-result"), [
      "provider-authored-result",
      "provider-authored-result"
    ]);
    assert.equal(provider.reasoningStepCallsAfterCompose, 0);
    assert.ok(provider.composeRepairContextChars > 0);
    assert.ok(provider.composeRepairContextChars < 20_000);
    assert.equal(provider.readmeEvidenceAllowedDuringRepair, true);
    assert.ok(result.result.evidenceRefs.some((id) => result.trace.evidenceRefs.some((entry) => entry.id === id && entry.path === "README.md")));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("reasoning repair receives bounded compact context after large evidence", async () => {
  const workspace = await fixture();
  try {
    const paths: string[] = [];
    for (let index = 0; index < 10; index += 1) {
      const filePath = `src/repair-large-${index}.ts`;
      paths.push(filePath);
      await writeFile(path.join(workspace, filePath), `export const repairValue${index} = "${"x".repeat(8_000)}";\n`, "utf8");
    }
    const provider = new BoundedReasonRepairProvider(paths);
    const result = await runAdaptiveReasoningTurn({
      provider,
      message: "Summarize the repair sources.",
      sessionId: "session_bounded_reason_repair",
      tools: new ToolRegistry(workspace)
    });

    assert.equal(result.result.decision, "ANSWER");
    assert.ok(provider.repairContextChars > 0);
    assert.ok(provider.repairContextChars < 20_000);
    assert.ok(result.trace.repairErrors.some((entry) => entry.kind === "provider_failure" && entry.stage === "reason"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("verifier rejection returns to the provider loop for additional evidence and a repaired answer", async () => {
  const workspace = await fixture();
  try {
    const provider = new VerifierRepairProvider();
    const result = await runAdaptiveReasoningTurn({
      provider,
      verifierProvider: provider,
      message: "Where does the beacon send its payload?",
      sessionId: "session_verifier_repair",
      tools: new ToolRegistry(workspace)
    });

    assert.equal(result.result.decision, "ANSWER");
    assert.equal(result.trace.verificationResults.length, 2);
    assert.equal(result.trace.verificationResults[0]?.verdict, "needs_more_evidence");
    assert.equal(result.trace.verificationResults[1]?.verdict, "pass");
    assert.ok(result.trace.toolResults.some((entry) => entry.kind === "read_file"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("verifier validation repair is not exhausted by operational provider repairs", async () => {
  const workspace = await fixture();
  try {
    const provider = new OperationalRepairBudgetVerifierProvider();
    const result = await runAdaptiveReasoningTurn({
      provider,
      verifierProvider: provider,
      message: "Where does the beacon send its payload?",
      sessionId: "session_verifier_after_operational_repairs",
      tools: new ToolRegistry(workspace)
    });

    assert.equal(result.result.decision, "ANSWER");
    assert.equal(result.trace.budget.profile, "deep_project");
    assert.equal(result.trace.verificationResults.length, 2);
    assert.equal(result.trace.verificationResults[0]?.verdict, "needs_more_evidence");
    assert.equal(result.trace.verificationResults[1]?.verdict, "pass");
    assert.equal(provider.validationRepairReasoningSeen, true);
    assert.equal(provider.textVerifierCalls, 1);
    assert.ok(result.trace.repairAttempts >= 3);
    assert.ok(result.trace.toolResults.some((entry) => entry.kind === "read_file" && entry.evidenceRefs.some((ref) => ref.path === "src/beacon.ts")));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("verifier rejection of a composed answer repairs through compose instead of another reasoning loop", async () => {
  const workspace = await fixture();
  try {
    await writeFile(
      path.join(workspace, "README.md"),
      "# Hivo Studio\n\nHivo Studio is an orchestration-first multi-agent coding system with durable repository memory.\n",
      "utf8"
    );
    const provider = new VerifierComposeRepairProvider();
    const result = await runAdaptiveReasoningTurn({
      provider,
      verifierProvider: provider,
      message: "What is this project for?",
      sessionId: "session_verifier_compose_repair",
      tools: new ToolRegistry(workspace)
    });

    assert.equal(result.result.decision, "ANSWER");
    assert.equal(provider.reasoningCallsAfterCompose, 0);
    assert.deepEqual(provider.schemas.filter((schema) => schema === "provider-authored-result"), [
      "provider-authored-result",
      "provider-authored-result"
    ]);
    assert.deepEqual(result.trace.verificationResults.map((entry) => entry.verdict), ["fail", "pass"]);
    assert.ok(result.result.evidenceRefs.some((id) => result.trace.evidenceRefs.some((entry) => entry.id === id && entry.path === "README.md")));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("malformed evidence curation is disabled without losing direct read-file evidence", async () => {
  const workspace = await fixture();
  try {
    await writeFile(
      path.join(workspace, "README.md"),
      "# Hivo Studio\n\nHivo Studio is an orchestration-first multi-agent coding system.\n",
      "utf8"
    );
    const paths = ["README.md"];
    for (let index = 0; index < 12; index += 1) {
      const filePath = `src/noisy-curation-${index}.ts`;
      paths.push(filePath);
      await writeFile(path.join(workspace, filePath), `export const noisyCuration${index} = "${"x".repeat(9_000)}";\n`, "utf8");
    }
    const provider = new BrokenCurationProvider(paths);
    const result = await runAdaptiveReasoningTurn({
      provider,
      message: "What is this project for?",
      sessionId: "session_broken_curation",
      tools: new ToolRegistry(workspace)
    });

    assert.equal(result.result.decision, "ANSWER");
    assert.equal(provider.curationCalls, 1);
    assert.equal(provider.readmeEvidenceSeenAfterCurationFailure, true);
    assert.ok(result.trace.repairErrors.some((entry) => entry.kind === "provider_failure" && entry.stage === "curate"));
    assert.ok(result.result.evidenceRefs.some((id) => result.trace.evidenceRefs.some((entry) => entry.id === id && entry.path === "README.md")));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("structured compose and verify failures fall back to provider-authored text without repair loops", async () => {
  const workspace = await fixture();
  try {
    await writeFile(
      path.join(workspace, "README.md"),
      "# Hivo Studio\n\nHivo Studio is an orchestration-first multi-agent coding system.\n",
      "utf8"
    );
    const provider = new TextFallbackComposeVerifyProvider();
    const result = await runAdaptiveReasoningTurn({
      provider,
      verifierProvider: provider,
      message: "What is this project for?",
      sessionId: "session_text_fallback_compose_verify",
      tools: new ToolRegistry(workspace)
    });

    assert.equal(result.result.decision, "ANSWER");
    assert.match(result.result.answerMarkdown, /Hivo Studio/);
    assert.match(result.result.answerMarkdown, /\[evidence_/);
    assert.deepEqual(provider.schemas.filter((schema) => schema === "provider-authored-result"), [
      "provider-authored-result",
      "provider-authored-result"
    ]);
    assert.deepEqual(provider.schemas.filter((schema) => schema === "answer-verification"), ["answer-verification"]);
    assert.deepEqual(provider.textPurposes, ["compose", "verify"]);
    assert.deepEqual(result.trace.verificationResults.map((entry) => entry.verdict), ["pass"]);
    assert.ok(result.result.evidenceRefs.some((id) => result.trace.evidenceRefs.some((entry) => entry.id === id && entry.path === "README.md")));
    assert.ok(result.trace.providerCalls <= 8);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("semantic_search uses provider embeddings for paraphrased project questions", async () => {
  const workspace = await fixture();
  try {
    await rebuildRepoIndex(workspace);
    const provider = new HybridSemanticProvider();
    const result = await runAdaptiveReasoningTurn({
      provider,
      message: "Where does the travelling payload finally rest?",
      sessionId: "session_semantic",
      tools: new ToolRegistry(workspace),
      embeddingModel: "test-semantic"
    });

    const semanticResult = result.trace.toolResults.find((entry) => entry.kind === "semantic_search");
    assert.equal((semanticResult?.data as { retrieval?: { vectorUsed?: boolean } }).retrieval?.vectorUsed, true);
    assert.ok((semanticResult?.data as { nodes?: Array<{ path?: string }> }).nodes?.some((node) => node.path === "src/beacon.ts"));
    assert.equal(result.result.decision, "ANSWER");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("delegate_readonly returns provider-backed review evidence to the adaptive loop within its budget", async () => {
  const workspace = await fixture();
  try {
    const evidenceStore = new EvidenceStore();
    const provider = new DelegationProvider();
    const result = await runAdaptiveReasoningTurn({
      provider,
      message: "Ask a read-only specialist to review the beacon flow.",
      sessionId: "session_delegate",
      tools: new ToolRegistry(workspace),
      evidenceStore,
      delegateReadonly: async (request, budget) => {
        assert.ok(budget.remainingProviderCalls > 0);
        const evidence = evidenceStore.add({
          sourceType: "delegated_review",
          summary: "Specialist review",
          excerpt: "The specialist traced unusualBeacon to archiveRecord."
        });
        return {
          providerCallsUsed: 2,
          result: {
            requestId: request.id,
            kind: request.kind,
            status: "success",
            summary: "Collected one specialist review.",
            evidenceRefs: [evidence],
            data: { reviews: ["The specialist traced unusualBeacon to archiveRecord."] },
            createdAt: new Date().toISOString()
          }
        };
      }
    });

    assert.equal(result.result.decision, "ANSWER");
    assert.equal(result.trace.toolResults[0]?.kind, "delegate_readonly");
    assert.equal(result.trace.providerCalls, 5);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("zero-match repository search is unavailable and the provider can continue with another read tool", async () => {
  const workspace = await fixture();
  try {
    const provider = new NoMatchRecoveryProvider();
    const result = await runAdaptiveReasoningTurn({
      provider,
      message: "Investigate a paraphrased project concept.",
      sessionId: "session_no_match_recovery",
      tools: new ToolRegistry(workspace)
    });
    assert.equal(result.trace.toolResults[0]?.status, "unavailable");
    assert.deepEqual(result.trace.toolResults.map((entry) => entry.kind), ["repository_search", "list_files"]);
    assert.equal(result.result.decision, "FOLLOW_UP");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("ranked term retrieval recovers candidates when a long provider query has no literal phrase match", async () => {
  const workspace = await fixture();
  try {
    const tools = new ToolRegistry(workspace);
    assert.equal(tools.workspace.searchCode("beacon archive payload flow", 10).length, 0);
    assert.ok(tools.workspace.searchCodeTerms("beacon archive payload flow", 10).some((match) => match.path === "src/beacon.ts"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("duplicate tool batches are not re-executed and an independent provider repairs the stagnant loop", async () => {
  const workspace = await fixture();
  try {
    const result = await runAdaptiveReasoningTurn({
      provider: new DuplicateBatchAuthorProvider(),
      verifierProvider: new DuplicateBatchRepairProvider(),
      message: "Investigate the workspace without repeating the same discovery batch.",
      sessionId: "session_duplicate_batch_repair",
      tools: new ToolRegistry(workspace)
    });

    assert.equal(result.result.decision, "ANSWER");
    assert.equal(result.trace.toolRounds, 1);
    assert.deepEqual(result.trace.toolResults.map((entry) => entry.kind), ["list_files"]);
    assert.ok(result.trace.repairAttempts >= 1);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("tool round budget composes from current evidence instead of failing a provider-authored turn", async () => {
  const workspace = await fixture();
  try {
    const paths: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      const filePath = `src/tool-budget-${index}.ts`;
      paths.push(filePath);
      await writeFile(path.join(workspace, filePath), `export const budgetFact${index} = "fact-${index}";\n`, "utf8");
    }
    const provider = new ToolBudgetComposeProvider(paths);
    const result = await runAdaptiveReasoningTurn({
      provider,
      message: "Keep reading until the tool budget is reached.",
      sessionId: "session_tool_budget_compose",
      tools: new ToolRegistry(workspace)
    });

    assert.equal(result.result.decision, "ANSWER");
    assert.equal(result.trace.toolRounds, 4);
    assert.equal(provider.composeCalls, 1);
    assert.ok(result.trace.repairErrors.some((entry) => /Tool round budget reached/i.test(entry.message)));
    assert.ok(result.result.evidenceRefs.every((id) => result.trace.evidenceRefs.some((entry) => entry.id === id)));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("terminal provider failure preserves the partial reasoning trace without a local result", async () => {
  const workspace = await fixture();
  try {
    const provider = new TerminalFailureProvider();
    await assert.rejects(
      runAdaptiveReasoningTurn({
        provider,
        message: "Trace the beacon and then explain it.",
        sessionId: "session_terminal_trace",
        tools: new ToolRegistry(workspace)
      }),
      (error: unknown) => {
        assert.ok(error instanceof ReasoningKernelFailure);
        assert.match(error.message, /provider_failed_after_retries/);
        assert.equal(error.trace.terminalFailure, error.message);
        assert.equal(error.trace.steps.length, 1);
        assert.equal(error.trace.toolRounds, 1);
        assert.equal(error.trace.toolResults[0]?.kind, "repository_search");
        assert.ok(error.trace.evidenceRefs.length > 0);
        return true;
      }
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("independent verifier can reclassify a missed workspace question and promote its tool budget", async () => {
  const workspace = await fixture();
  try {
    const result = await runAdaptiveReasoningTurn({
      provider: new ReclassificationAuthorProvider(),
      verifierProvider: new ReclassificationVerifierProvider(),
      message: "Trace how this system sends the unusual beacon to its archive.",
      sessionId: "session_verifier_reclassification",
      tools: new ToolRegistry(workspace)
    });

    assert.equal(result.result.decision, "ANSWER");
    assert.equal(result.trace.understanding.needsWorkspace, true);
    assert.equal(result.trace.budget.profile, "deep_project");
    assert.equal(result.trace.toolRounds, 1);
    assert.equal(result.trace.toolResults[0]?.kind, "repository_search");
    assert.equal(result.trace.verificationResults[0]?.workspaceEvidenceRequired, true);
    assert.equal(result.trace.verificationResults[1]?.verdict, "pass");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("independent verifier catches a high-confidence missed workspace route before accepting the initial final", async () => {
  const workspace = await fixture();
  try {
    const result = await runAdaptiveReasoningTurn({
      provider: new ReclassificationAuthorProvider(),
      verifierProvider: new RouteAuditVerifierProvider(),
      message: "Trace how this system sends the unusual beacon to its archive.",
      sessionId: "session_route_audit_reclassification",
      tools: new ToolRegistry(workspace)
    });

    assert.equal(result.result.decision, "ANSWER");
    assert.equal(result.trace.understanding.needsWorkspace, true);
    assert.equal(result.trace.budget.profile, "deep_project");
    assert.equal(result.trace.steps[0]?.id, "incorrect_direct_answer");
    assert.equal(result.trace.toolRounds, 1);
    assert.equal(result.trace.verificationResults.length, 2);
    assert.ok(result.trace.repairErrors.some((entry) => entry.kind === "wrong_route"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

class AdaptiveProjectProvider implements LlmProvider {
  schemas: string[] = [];

  async generateStructured<T>(input: LlmRequest, schema: unknown): Promise<T> {
    const name = schemaName(schema);
    this.schemas.push(name);
    if (name === "initial-reasoning-decision") {
      return {
        understanding: understanding("workspace_question", "inspect_explain"),
        step: {
          id: "search_beacon_step",
          kind: "tool_batch",
          rationale: "Search for the unfamiliar implementation term first.",
          toolRequests: [{ id: "search_beacon", kind: "repository_search", query: "unusualBeacon", reason: "Locate the implementation." }],
          missingFacts: ["Where the beacon is implemented."],
          successCriteria: ["Trace the implementation to the archive."]
        }
      } as T;
    }
    if (name === "reasoning-step") {
      const context = input.context as {
        toolResults: Array<{ kind: string; data?: { matches?: Array<{ path: string }> } }>;
        allowedEvidenceIds: string[];
      };
      if (context.toolResults.length === 1) {
        return {
          id: "read_beacon",
          kind: "tool_batch",
          rationale: "Read the implementation found by search.",
          toolRequests: [{ id: "read_beacon_file", kind: "read_file", path: context.toolResults[0]?.data?.matches?.[0]?.path, reason: "Verify the full flow." }],
          missingFacts: [],
          successCriteria: ["Explain the verified flow."]
        } satisfies ReasoningStep as T;
      }
      const evidenceId = context.allowedEvidenceIds.at(-1)!;
      return {
        id: "final_beacon",
        kind: "final",
        rationale: "The source file proves the flow.",
        toolRequests: [],
        missingFacts: [],
        successCriteria: ["Explain the verified flow."],
        result: {
          decision: "ANSWER",
          answerMarkdown: "The beacon passes its payload to archiveRecord.",
          claims: [{ id: "claim_1", text: "The beacon passes its payload to archiveRecord.", material: true, evidenceIds: [evidenceId], confidence: "high" }],
          evidenceRefs: [evidenceId],
          unknowns: [],
          rationale: "Answer grounded in the provider-requested file read."
        }
      } satisfies ReasoningStep as T;
    }
    if (name === "answer-verification") {
      const context = input.context as { result: ProviderAuthoredResult; allowedEvidenceIds: string[] };
      return {
        verdict: "pass",
        rationale: "The material claim is directly supported by the supplied source evidence.",
        supportedClaims: context.result.claims.map((claim) => typeof claim === "string" ? claim : claim.text),
        unsupportedClaims: [],
        missingFacts: [],
        evidenceRefs: context.allowedEvidenceIds
      } as T;
    }
    throw new Error(`Unexpected schema ${name}`);
  }

  async generateText(): Promise<string> {
    throw new Error("Unexpected text request");
  }
}

class FinalWithoutResultProvider implements LlmProvider {
  static readonly answer = "The beacon passes its payload to archiveRecord.";
  readonly schemas: string[] = [];

  async generateStructured<T>(input: LlmRequest, schema: unknown): Promise<T> {
    const name = schemaName(schema);
    this.schemas.push(name);
    if (name === "initial-reasoning-decision") {
      return {
        understanding: understanding("workspace_question", "inspect_explain"),
        step: {
          id: "read_beacon_before_compose",
          kind: "tool_batch",
          rationale: "Read the implementation before answering.",
          toolRequests: [{ id: "read_beacon_for_compose", kind: "read_file", path: "src/beacon.ts", reason: "Ground the answer in source." }],
          missingFacts: ["Beacon implementation."],
          successCriteria: ["Answer from source evidence."]
        }
      } as T;
    }
    if (name === "reasoning-step") {
      return {
        id: "final_without_embedded_result",
        kind: "final",
        rationale: "The source evidence is enough; let compose author the result.",
        toolRequests: [],
        missingFacts: [],
        successCriteria: ["Compose a provider-authored answer."]
      } satisfies ReasoningStep as T;
    }
    if (name === "provider-authored-result") {
      const evidenceId = (input.context as { allowedEvidenceRefs: string[] }).allowedEvidenceRefs[0]!;
      return {
        decision: "ANSWER",
        answerMarkdown: FinalWithoutResultProvider.answer,
        claims: [{ id: "beacon_compose_claim", text: FinalWithoutResultProvider.answer, material: true, evidenceIds: [evidenceId], confidence: "high" }],
        evidenceRefs: [evidenceId],
        unknowns: [],
        rationale: "The compose stage authored the final answer from the supplied source evidence."
      } satisfies ProviderAuthoredResult as T;
    }
    if (name === "answer-verification") return passingVerification(input) as T;
    throw new Error(`Unexpected schema ${name}`);
  }

  async generateText(): Promise<string> {
    throw new Error("Unexpected text request");
  }
}

class TerminalFailureProvider implements LlmProvider {
  private calls = 0;

  async generateText(): Promise<string> {
    throw new Error("provider unavailable");
  }

  async generateStructured<T>(): Promise<T> {
    this.calls += 1;
    if (this.calls === 1) {
      return {
        understanding: understanding("workspace_question", "inspect_explain"),
        step: {
          id: "search_before_failure",
          kind: "tool_batch",
          rationale: "Locate the implementation before explaining it.",
          toolRequests: [{ id: "search_beacon_before_failure", kind: "repository_search", query: "unusualBeacon", reason: "Find the implementation." }],
          missingFacts: ["Implementation location."],
          successCriteria: ["Explain the implementation."]
        }
      } as T;
    }
    throw new Error("provider unavailable");
  }
}

class DuplicateBatchAuthorProvider implements LlmProvider {
  async generateText(): Promise<string> {
    throw new Error("Unexpected text request");
  }

  async generateStructured<T>(_input: LlmRequest, schema: unknown): Promise<T> {
    const name = schemaName(schema);
    if (name === "initial-reasoning-decision") {
      return {
        understanding: understanding("workspace_question", "inspect_explain"),
        step: duplicateListStep("initial_duplicate_list")
      } as T;
    }
    if (name === "reasoning-step") return duplicateListStep("repeated_duplicate_list") as T;
    throw new Error(`Unexpected schema ${name}`);
  }
}

class DuplicateBatchRepairProvider implements LlmProvider {
  async generateText(): Promise<string> {
    throw new Error("Unexpected text request");
  }

  async generateStructured<T>(input: LlmRequest, schema: unknown): Promise<T> {
    const name = schemaName(schema);
    if (name === "reasoning-step") {
      const evidenceId = (input.context as { allowedEvidenceIds: string[] }).allowedEvidenceIds[0]!;
      return {
        id: "independent_stagnation_repair",
        kind: "final",
        rationale: "Do not repeat the discovery batch; report the grounded result.",
        toolRequests: [],
        missingFacts: [],
        successCriteria: [],
        result: {
          decision: "ANSWER",
          answerMarkdown: "The workspace listing was collected once.",
          claims: [{ id: "listing_once", text: "The workspace listing was collected once.", material: true, evidenceIds: [evidenceId], confidence: "high" }],
          evidenceRefs: [evidenceId],
          unknowns: [],
          rationale: "Independent provider repaired the stagnant tool loop."
        }
      } as T;
    }
    if (name === "answer-verification") return passingVerification(input) as T;
    throw new Error(`Unexpected schema ${name}`);
  }
}

class ToolBudgetComposeProvider implements LlmProvider {
  composeCalls = 0;

  constructor(private readonly paths: string[]) {}

  async generateText(): Promise<string> {
    throw new Error("Unexpected text request");
  }

  async generateStructured<T>(input: LlmRequest, schema: unknown): Promise<T> {
    const name = schemaName(schema);
    if (name === "initial-reasoning-decision") {
      return {
        understanding: understanding("workspace_question", "inspect_explain"),
        step: {
          id: "tool_budget_initial_read",
          kind: "tool_batch",
          rationale: "Collect initial evidence.",
          toolRequests: [{ id: "tool_budget_initial_read", kind: "read_file", path: this.paths[0], reason: "Collect budget evidence." }],
          missingFacts: [],
          successCriteria: ["Collect enough evidence to answer."]
        }
      } as T;
    }
    if (name === "reasoning-step") {
      const context = input.context as { toolResults: unknown[] };
      const nextPath = this.paths[context.toolResults.length] ?? this.paths.at(-1)!;
      return {
        id: `tool_budget_more_${context.toolResults.length}`,
        kind: "tool_batch",
        rationale: "Request another distinct read until the kernel enforces its tool budget.",
        toolRequests: [{ id: `tool_budget_more_${context.toolResults.length}`, kind: "read_file", path: nextPath, reason: "Collect another budget evidence file." }],
        missingFacts: [],
        successCriteria: ["Continue collecting evidence."]
      } as T;
    }
    if (name === "provider-authored-result") {
      this.composeCalls += 1;
      const evidenceId = (input.context as { allowedEvidenceRefs: string[] }).allowedEvidenceRefs[0]!;
      return {
        decision: "ANSWER",
        answerMarkdown: "The provider composed an answer from the evidence collected before the tool budget was reached.",
        claims: [{ id: "tool_budget_compose_claim", text: "The answer was composed from collected evidence.", material: true, evidenceIds: [evidenceId], confidence: "high" }],
        evidenceRefs: [evidenceId],
        unknowns: [],
        rationale: "The kernel stopped further tool calls and requested provider compose."
      } satisfies ProviderAuthoredResult as T;
    }
    if (name === "answer-verification") return passingVerification(input) as T;
    throw new Error(`Unexpected schema ${name}`);
  }
}

class MalformedClaimRepairProvider implements LlmProvider {
  readonly schemas: string[] = [];
  private reasoningStepCalls = 0;

  async generateStructured<T>(input: LlmRequest, schema: unknown): Promise<T> {
    const name = schemaName(schema);
    this.schemas.push(name);
    if (name === "initial-reasoning-decision") {
      return {
        understanding: understanding("workspace_question", "inspect_explain"),
        step: {
          id: "read_before_malformed_claim",
          kind: "tool_batch",
          rationale: "Read the source before answering.",
          toolRequests: [{ id: "read_before_malformed_claim_request", kind: "read_file", path: "src/beacon.ts", reason: "Ground the answer." }],
          missingFacts: [],
          successCriteria: ["Answer from source evidence."]
        }
      } as T;
    }
    if (name === "reasoning-step") {
      this.reasoningStepCalls += 1;
      const evidenceId = evidenceIdFromReasoningContext(input.context);
      if (this.reasoningStepCalls === 1) {
        return {
          id: "malformed_claim_final",
          kind: "final",
          rationale: "Return a malformed embedded result to exercise schema repair.",
          toolRequests: [],
          missingFacts: [],
          successCriteria: ["Repair malformed claim shape."],
          result: {
            decision: "ANSWER",
            answerMarkdown: "The beacon passes its payload to archiveRecord.",
            claims: [{ id: "malformed_claim", text: "The beacon passes its payload to archiveRecord.", material: true, confidence: "high" }],
            evidenceRefs: [evidenceId],
            unknowns: [],
            rationale: "Malformed claim omitted evidenceIds."
          }
        } as unknown as T;
      }
      return finalBeaconStep([evidenceId], "The beacon passes its payload to archiveRecord.") as T;
    }
    if (name === "answer-verification") return passingVerification(input) as T;
    throw new Error(`Unexpected schema ${name}`);
  }

  async generateText(): Promise<string> {
    throw new Error("Unexpected text request");
  }
}

function evidenceIdFromReasoningContext(context: unknown) {
  const direct = (context as { allowedEvidenceIds?: string[] } | undefined)?.allowedEvidenceIds;
  if (direct?.length) return direct.at(-1)!;
  const original = (context as { originalRequest?: { context?: { allowedEvidenceIds?: string[] } } } | undefined)?.originalRequest?.context?.allowedEvidenceIds;
  if (original?.length) return original.at(-1)!;
  const invalidResult = (context as { invalidResult?: { result?: { evidenceRefs?: string[] } } } | undefined)?.invalidResult?.result?.evidenceRefs;
  if (invalidResult?.length) return invalidResult.at(-1)!;
  throw new Error("missing test evidence id");
}

class ReclassificationAuthorProvider implements LlmProvider {
  async generateText(): Promise<string> {
    throw new Error("Unexpected text request");
  }

  async generateStructured<T>(input: LlmRequest, schema: unknown): Promise<T> {
    const name = schemaName(schema);
    if (name === "initial-reasoning-decision") {
      return {
        understanding: understanding("direct_conversation", "chat"),
        step: {
          id: "incorrect_direct_answer",
          kind: "final",
          rationale: "Initially treated the request as general conversation.",
          toolRequests: [],
          missingFacts: [],
          successCriteria: [],
          result: {
            decision: "ANSWER",
            answerMarkdown: "The beacon reaches the archive.",
            claims: [],
            evidenceRefs: [],
            unknowns: [],
            rationale: "Initial direct answer."
          }
        }
      } as T;
    }
    if (name === "reasoning-step") {
      const context = input.context as { toolResults: unknown[]; allowedEvidenceIds: string[] };
      if (!context.toolResults.length) {
        return {
          id: "search_after_reclassification",
          kind: "tool_batch",
          rationale: "The verifier established that workspace evidence is required.",
          toolRequests: [{ id: "search_after_reclassification_request", kind: "repository_search", query: "unusualBeacon", reason: "Trace the implementation." }],
          missingFacts: [],
          successCriteria: ["Ground the answer in workspace evidence."]
        } as T;
      }
      const evidenceId = context.allowedEvidenceIds[0]!;
      return {
        id: "answer_after_reclassification",
        kind: "final",
        rationale: "The provider-requested search supplied workspace evidence.",
        toolRequests: [],
        missingFacts: [],
        successCriteria: ["Ground the answer in workspace evidence."],
        result: {
          decision: "ANSWER",
          answerMarkdown: "The unusualBeacon implementation calls archiveRecord.",
          claims: [{ id: "claim_reclassified", text: "The unusualBeacon implementation calls archiveRecord.", material: true, evidenceIds: [evidenceId], confidence: "high" }],
          evidenceRefs: [evidenceId],
          unknowns: [],
          rationale: "Answer grounded after verifier reclassification."
        }
      } as T;
    }
    throw new Error(`Unexpected schema ${name}`);
  }
}

class ReclassificationVerifierProvider implements LlmProvider {
  private calls = 0;

  async generateText(): Promise<string> {
    throw new Error("Unexpected text request");
  }

  async generateStructured<T>(input: LlmRequest, schema: unknown): Promise<T> {
    const name = schemaName(schema);
    if (name === "turn-understanding") return understanding("direct_conversation", "chat") as T;
    if (name !== "answer-verification") throw new Error(`Unexpected schema ${name}`);
    this.calls += 1;
    if (this.calls === 1) {
      return {
        verdict: "needs_more_evidence",
        rationale: "The request asks about the current system's cross-file implementation.",
        workspaceEvidenceRequired: true,
        recommendedBudgetProfile: "deep_project",
        supportedClaims: [],
        unsupportedClaims: [],
        missingFacts: ["Locate and inspect the beacon implementation."],
        evidenceRefs: []
      } as T;
    }
    return {
      ...passingVerification(input),
      workspaceEvidenceRequired: true,
      recommendedBudgetProfile: "deep_project"
    } as T;
  }
}

class RouteAuditVerifierProvider implements LlmProvider {
  async generateText(): Promise<string> {
    throw new Error("Unexpected text request");
  }

  async generateStructured<T>(input: LlmRequest, schema: unknown): Promise<T> {
    const name = schemaName(schema);
    if (name === "turn-understanding") {
      return {
        ...understanding("workspace_question", "swarm_readonly"),
        risk: "high",
        rationale: "The request asks for a deep cross-file trace of the current system."
      } as T;
    }
    if (name === "reasoning-step") {
      return {
        id: "route_audit_search",
        kind: "tool_batch",
        rationale: "The independent route audit requires workspace evidence.",
        toolRequests: [{ id: "route_audit_search_request", kind: "repository_search", query: "unusualBeacon", reason: "Trace the current implementation." }],
        missingFacts: ["Current implementation evidence."],
        successCriteria: ["Ground the answer in workspace evidence."]
      } as T;
    }
    if (name === "answer-verification") {
      return {
        ...passingVerification(input),
        workspaceEvidenceRequired: true,
        recommendedBudgetProfile: "deep_project"
      } as T;
    }
    throw new Error(`Unexpected schema ${name}`);
  }
}

class CommandRequestProvider implements LlmProvider {
  async generateStructured<T>(input: LlmRequest, schema: unknown): Promise<T> {
    const name = schemaName(schema);
    if (name === "initial-reasoning-decision") {
      return {
        understanding: understanding("run_request", "simple_run"),
        step: {
          id: "run_tests_step",
          kind: "tool_batch",
          rationale: "Request the test command through authority.",
          toolRequests: [{ id: "run_tests", kind: "run_command", command: "npm test", reason: "Verify the project." }],
          missingFacts: [],
          successCriteria: ["Receive an authoritative command result."]
        }
      } as T;
    }
    if (name === "reasoning-step") {
      const context = input.context as { allowedEvidenceIds: string[] };
      const evidenceId = context.allowedEvidenceIds[0]!;
      return {
        id: "await_command",
        kind: "escalate",
        rationale: "Rust authority must execute the requested command.",
        toolRequests: [],
        missingFacts: ["Command result is pending approval."],
        successCriteria: ["Receive the command result."],
        result: {
          decision: "ESCALATE",
          answerMarkdown: "The test command is waiting for approval.",
          claims: [],
          evidenceRefs: [evidenceId],
          unknowns: ["The command has not executed yet."],
          rationale: "Execution authority is pending."
        } satisfies ProviderAuthoredResult
      } satisfies ReasoningStep as T;
    }
    throw new Error(`Unexpected schema ${name}`);
  }

  async generateText(): Promise<string> {
    throw new Error("Unexpected text request");
  }
}

class ListingProvider implements LlmProvider {
  sawBeaconPath = false;

  async generateStructured<T>(input: LlmRequest, schema: unknown): Promise<T> {
    const name = schemaName(schema);
    if (name === "initial-reasoning-decision") {
      return {
        understanding: understanding("workspace_question", "inspect_explain"),
        step: {
          id: "list_workspace_step",
          kind: "tool_batch",
          rationale: "List files before choosing what to read.",
          toolRequests: [{ id: "list_workspace", kind: "list_files", reason: "Discover candidate paths." }],
          missingFacts: ["Candidate source paths."],
          successCriteria: ["Observe the workspace paths."]
        }
      } as T;
    }
    if (name === "reasoning-step") {
      const context = input.context as { toolResults: Array<{ data?: { files?: string[] } }>; allowedEvidenceIds: string[] };
      this.sawBeaconPath = context.toolResults[0]?.data?.files?.includes("src/beacon.ts") ?? false;
      return {
        id: "listing_follow_up",
        kind: "ask_user",
        rationale: "The listing is visible; ask which flow to inspect next.",
        toolRequests: [],
        missingFacts: [],
        successCriteria: [],
        result: {
          decision: "FOLLOW_UP",
          answerMarkdown: "I found the source paths. Which flow should I inspect?",
          claims: [],
          evidenceRefs: context.allowedEvidenceIds,
          unknowns: [],
          rationale: "The provider inspected the workspace listing."
        }
      } satisfies ReasoningStep as T;
    }
    throw new Error(`Unexpected schema ${name}`);
  }

  async generateText(): Promise<string> {
    throw new Error("Unexpected text request");
  }
}

class CurationProvider implements LlmProvider {
  readonly schemas: string[] = [];
  curationContextChars = 0;

  constructor(private readonly paths: string[]) {}

  async generateStructured<T>(input: LlmRequest, schema: unknown): Promise<T> {
    const name = schemaName(schema);
    this.schemas.push(name);
    if (name === "initial-reasoning-decision") {
      return {
        understanding: understanding("workspace_question", "inspect_explain"),
        step: {
          id: "read_large_sources",
          kind: "tool_batch",
          rationale: "Read the requested records.",
          toolRequests: [{ id: "read_large", kind: "read_file", paths: this.paths, reason: "Compare the records." }],
          missingFacts: [],
          successCriteria: ["Compare selected evidence."]
        }
      } as T;
    }
    if (name === "evidence-curation") {
      this.curationContextChars = JSON.stringify(input.context).length;
      const inventory = (input.context as { evidenceInventory: Array<{ id: string }> }).evidenceInventory;
      return {
        selectedEvidenceRefs: inventory.slice(-2).map((entry) => entry.id),
        missingFacts: [],
        rationale: "The final two records are sufficient for this bounded comparison."
      } as T;
    }
    if (name === "reasoning-step") {
      const allowed = (input.context as { allowedEvidenceIds: string[] }).allowedEvidenceIds;
      return {
        id: "final_curated",
        kind: "final",
        rationale: "The curated source records support the answer.",
        toolRequests: [],
        missingFacts: [],
        successCriteria: [],
        result: {
          decision: "ANSWER",
          answerMarkdown: "The selected records expose large constant values.",
          claims: [{ id: "curated_claim", text: "The selected records expose large constant values.", material: true, evidenceIds: [allowed.at(-1)!], confidence: "high" }],
          evidenceRefs: [allowed.at(-1)!],
          unknowns: [],
          rationale: "Grounded in curated evidence."
        }
      } as T;
    }
    if (name === "answer-verification") return passingVerification(input) as T;
    throw new Error(`Unexpected schema ${name}`);
  }

  async generateText(): Promise<string> {
    throw new Error("Unexpected text request");
  }
}

class BoundedComposeProvider implements LlmProvider {
  composeContextChars = 0;

  constructor(private readonly paths: string[]) {}

  async generateStructured<T>(input: LlmRequest, schema: unknown): Promise<T> {
    const name = schemaName(schema);
    if (name === "initial-reasoning-decision") {
      return {
        understanding: understanding("workspace_question", "inspect_explain"),
        step: {
          id: "read_large_before_compose",
          kind: "tool_batch",
          rationale: "Read enough source records to force context curation before composing.",
          toolRequests: [{ id: "read_large_for_compose", kind: "read_file", paths: this.paths, reason: "Ground the summary in source files." }],
          missingFacts: [],
          successCriteria: ["Compose from bounded source evidence."]
        }
      } as T;
    }
    if (name === "evidence-curation") {
      const inventory = (input.context as { evidenceInventory: Array<{ id: string }> }).evidenceInventory;
      return {
        selectedEvidenceRefs: inventory.slice(-2).map((entry) => entry.id),
        missingFacts: [],
        rationale: "Two representative large source records are enough for the summary."
      } as T;
    }
    if (name === "reasoning-step") {
      return {
        id: "compose_large_final",
        kind: "final",
        rationale: "The curated evidence is enough; let compose author the answer.",
        toolRequests: [],
        missingFacts: [],
        successCriteria: ["Use bounded evidence."]
      } satisfies ReasoningStep as T;
    }
    if (name === "provider-authored-result") {
      const rawContext = input.context as {
        originalRequest?: {
          context?: {
            evidence?: unknown[];
            allowedEvidenceRefs?: string[];
            toolResults?: unknown[];
          };
        };
        evidence: unknown[];
        allowedEvidenceRefs: string[];
        toolResults: unknown[];
      };
      const context = (rawContext.originalRequest?.context ?? rawContext) as {
        evidence: unknown[];
        allowedEvidenceRefs: string[];
        toolResults: unknown[];
      };
      this.composeContextChars = JSON.stringify(context).length;
      assert.ok(context.evidence.length > 0);
      assert.ok(context.toolResults.length > 0);
      const evidenceId = context.allowedEvidenceRefs.at(-1)!;
      return {
        decision: "ANSWER",
        answerMarkdown: "The selected large source records define compose constants.",
        claims: [{ id: "bounded_compose_claim", text: "The selected large source records define compose constants.", material: true, evidenceIds: [evidenceId], confidence: "high" }],
        evidenceRefs: [evidenceId],
        unknowns: [],
        rationale: "Answer grounded in curated evidence."
      } satisfies ProviderAuthoredResult as T;
    }
    if (name === "answer-verification") return passingVerification(input) as T;
    throw new Error(`Unexpected schema ${name}`);
  }

  async generateText(): Promise<string> {
    throw new Error("Unexpected text request");
  }
}

class ComposeRepairProvider implements LlmProvider {
  readonly schemas: string[] = [];
  composeCalls = 0;
  composeRepairContextChars = 0;
  readmeEvidenceAllowedDuringRepair = false;
  reasoningStepCallsAfterCompose = 0;

  async generateStructured<T>(input: LlmRequest, schema: unknown): Promise<T> {
    const name = schemaName(schema);
    this.schemas.push(name);
    if (name === "initial-reasoning-decision") {
      return {
        understanding: understanding("workspace_question", "inspect_explain"),
        step: {
          id: "search_noisy_docs",
          kind: "tool_batch",
          rationale: "Start with a broad repository search that will return noisy matches.",
          toolRequests: [{ id: "search_noisy_docs", kind: "repository_search", query: "project-overview-noise", limit: 70, reason: "Find possible overview files." }],
          missingFacts: ["Project overview."],
          successCriteria: ["Read the project overview."]
        }
      } as T;
    }
    if (name === "reasoning-step") {
      const context = input.context as { toolResults: unknown[] };
      if (this.composeCalls > 0) this.reasoningStepCallsAfterCompose += 1;
      if (context.toolResults.length === 1) {
        return {
          id: "read_actual_readme",
          kind: "tool_batch",
          rationale: "Read the top-level README after broad search noise.",
          toolRequests: [{ id: "read_actual_readme", kind: "read_file", path: "README.md", reason: "Read project overview from the top-level README." }],
          missingFacts: ["README overview."],
          successCriteria: ["Compose from README evidence."]
        } as T;
      }
      return {
        id: "compose_from_readme",
        kind: "final",
        rationale: "The README evidence is sufficient; let compose author the answer.",
        toolRequests: [],
        missingFacts: [],
        successCriteria: ["Answer with README evidence."]
      } as T;
    }
    if (name === "evidence-curation") {
      const inventory = (input.context as { evidenceInventory: Array<{ id: string; path?: string }> }).evidenceInventory;
      return {
        selectedEvidenceRefs: inventory.filter((entry) => entry.path === "README.md").map((entry) => entry.id).concat(inventory.slice(0, 8).map((entry) => entry.id)),
        missingFacts: [],
        rationale: "Keep README evidence and a small sample of noisy matches."
      } as T;
    }
    if (name === "provider-authored-result") {
      this.composeCalls += 1;
      const context = input.context as {
        evidence: Array<{ id: string; path?: string; summary?: string }>;
        allowedEvidenceRefs: string[];
        validationErrors: string[];
      };
      const readmeEvidence = context.evidence.find((entry) => entry.path === "README.md" && entry.summary === "Read project overview from the top-level README.");
      if (this.composeCalls === 1) {
        return {
          decision: "ANSWER",
          answerMarkdown: "Hivo Studio is an orchestration-first multi-agent coding system.",
          claims: [],
          evidenceRefs: [],
          unknowns: [],
          rationale: "Intentionally omit evidence refs to exercise compose validation repair."
        } satisfies ProviderAuthoredResult as T;
      }
      this.composeRepairContextChars = JSON.stringify(context).length;
      this.readmeEvidenceAllowedDuringRepair = Boolean(readmeEvidence && context.allowedEvidenceRefs.includes(readmeEvidence.id));
      const evidenceId = readmeEvidence?.id ?? context.allowedEvidenceRefs[0]!;
      return {
        decision: "ANSWER",
        answerMarkdown: "Hivo Studio is an orchestration-first multi-agent coding system.",
        claims: [{ id: "readme_goal", text: "Hivo Studio is an orchestration-first multi-agent coding system.", material: true, evidenceIds: [evidenceId], confidence: "high" }],
        evidenceRefs: [evidenceId],
        unknowns: [],
        rationale: `Repaired using validation feedback: ${context.validationErrors.join("; ")}`
      } satisfies ProviderAuthoredResult as T;
    }
    if (name === "answer-verification") return passingVerification(input) as T;
    throw new Error(`Unexpected schema ${name}`);
  }

  async generateText(): Promise<string> {
    throw new Error("Unexpected text request");
  }
}

class BrokenCurationProvider implements LlmProvider {
  curationCalls = 0;
  readmeEvidenceSeenAfterCurationFailure = false;

  constructor(private readonly paths: string[]) {}

  async generateStructured<T>(input: LlmRequest, schema: unknown): Promise<T> {
    const name = schemaName(schema);
    if (name === "initial-reasoning-decision") {
      return {
        understanding: understanding("workspace_question", "inspect_explain"),
        step: {
          id: "read_readme_and_noisy_files",
          kind: "tool_batch",
          rationale: "Read the project overview and enough noisy files to force curation.",
          toolRequests: [{ id: "read_readme_and_noisy_files", kind: "read_file", paths: this.paths, reason: "Read project overview evidence." }],
          missingFacts: [],
          successCriteria: ["Answer from README evidence."]
        }
      } as T;
    }
    if (name === "evidence-curation") {
      this.curationCalls += 1;
      return {
        selectedEvidenceRefs: "not-an-array",
        missingFacts: [],
        rationale: "Intentionally malformed curation output."
      } as T;
    }
    if (name === "reasoning-step") {
      const context = input.context as { evidence: Array<{ id: string; path?: string }>; allowedEvidenceIds: string[] };
      const readmeEvidence = context.evidence.find((entry) => entry.path === "README.md");
      this.readmeEvidenceSeenAfterCurationFailure = Boolean(readmeEvidence && context.allowedEvidenceIds.includes(readmeEvidence.id));
      const evidenceId = readmeEvidence?.id ?? context.allowedEvidenceIds[0]!;
      return {
        id: "final_after_broken_curation",
        kind: "final",
        rationale: "Answer from deterministic evidence ordering after curation fails.",
        toolRequests: [],
        missingFacts: [],
        successCriteria: ["Use README evidence."],
        result: {
          decision: "ANSWER",
          answerMarkdown: "Hivo Studio is an orchestration-first multi-agent coding system.",
          claims: [{ id: "broken_curation_readme_goal", text: "Hivo Studio is an orchestration-first multi-agent coding system.", material: true, evidenceIds: [evidenceId], confidence: "high" }],
          evidenceRefs: [evidenceId],
          unknowns: [],
          rationale: "Direct read-file evidence remained available."
        }
      } satisfies ReasoningStep as T;
    }
    if (name === "answer-verification") return passingVerification(input) as T;
    throw new Error(`Unexpected schema ${name}`);
  }

  async generateText(): Promise<string> {
    throw new Error("Unexpected text request");
  }
}

class TextFallbackComposeVerifyProvider implements LlmProvider {
  readonly schemas: string[] = [];
  readonly textPurposes: string[] = [];

  async generateStructured<T>(input: LlmRequest, schema: unknown): Promise<T> {
    const name = schemaName(schema);
    this.schemas.push(name);
    if (name === "initial-reasoning-decision") {
      return {
        understanding: understanding("workspace_question", "inspect_explain"),
        step: {
          id: "read_readme_before_text_fallback",
          kind: "tool_batch",
          rationale: "Read README before composing.",
          toolRequests: [{ id: "read_readme_before_text_fallback", kind: "read_file", path: "README.md", reason: "Read project overview." }],
          missingFacts: [],
          successCriteria: ["Answer from README evidence."]
        }
      } as T;
    }
    if (name === "reasoning-step") {
      return {
        id: "compose_via_text_fallback",
        kind: "final",
        rationale: "Let compose author the answer.",
        toolRequests: [],
        missingFacts: [],
        successCriteria: ["Use README evidence."]
      } satisfies ReasoningStep as T;
    }
    if (name === "provider-authored-result") {
      return {
        decision: "ANSWER",
        answerMarkdown: "Hivo Studio is an orchestration-first multi-agent coding system.",
        claims: []
      } as unknown as T;
    }
    if (name === "answer-verification") {
      return {
        verdict: "pass"
      } as unknown as T;
    }
    throw new Error(`Unexpected schema ${name}`);
  }

  async generateText(input: LlmRequest): Promise<string> {
    const purpose = input.purpose ?? "unknown";
    this.textPurposes.push(purpose);
    if (purpose === "compose") {
      const evidenceId = (input.context as { allowedEvidenceRefs: string[] }).allowedEvidenceRefs[0]!;
      return `Hivo Studio is an orchestration-first multi-agent coding system. [${evidenceId}]`;
    }
    if (purpose === "verify") return "PASS\nThe README evidence supports the concise answer.";
    throw new Error(`Unexpected text purpose ${purpose}`);
  }
}

class BoundedReasonRepairProvider implements LlmProvider {
  repairContextChars = 0;
  private failedReasonOnce = false;

  constructor(private readonly paths: string[]) {}

  async generateStructured<T>(input: LlmRequest, schema: unknown): Promise<T> {
    const name = schemaName(schema);
    if (name === "initial-reasoning-decision") {
      return {
        understanding: understanding("workspace_question", "inspect_explain"),
        step: {
          id: "read_large_before_reason_repair",
          kind: "tool_batch",
          rationale: "Read large evidence before the reasoning repair path.",
          toolRequests: [{ id: "read_large_before_reason_repair", kind: "read_file", paths: this.paths, reason: "Ground the repair-context test." }],
          missingFacts: [],
          successCriteria: ["Summarize from large source evidence."]
        }
      } as T;
    }
    if (name === "evidence-curation") {
      const inventory = (input.context as { evidenceInventory: Array<{ id: string }> }).evidenceInventory;
      return {
        selectedEvidenceRefs: inventory.slice(0, 4).map((entry) => entry.id),
        missingFacts: [],
        rationale: "A small sample is enough for the repair test."
      } as T;
    }
    if (name === "reasoning-step") {
      if (!this.failedReasonOnce) {
        this.failedReasonOnce = true;
        throw new Error("real_provider.invalid_json: forced malformed reasoning-step");
      }
      this.repairContextChars = JSON.stringify(input.context).length;
      const originalContext = (input.context as { originalRequest: { context: { allowedEvidenceIds: string[] } } }).originalRequest.context;
      const evidenceId = originalContext.allowedEvidenceIds[0]!;
      return {
        id: "final_after_bounded_reason_repair",
        kind: "final",
        rationale: "Repair produced a final answer from compact context.",
        toolRequests: [],
        missingFacts: [],
        successCriteria: [],
        result: {
          decision: "ANSWER",
          answerMarkdown: "The repair sources define large constants.",
          claims: [{ id: "bounded_reason_repair_claim", text: "The repair sources define large constants.", material: true, evidenceIds: [evidenceId], confidence: "high" }],
          evidenceRefs: [evidenceId],
          unknowns: [],
          rationale: "Provider-authored result from compact repair context."
        }
      } as T;
    }
    if (name === "answer-verification") return passingVerification(input) as T;
    throw new Error(`Unexpected schema ${name}`);
  }

  async generateText(): Promise<string> {
    throw new Error("Unexpected text request");
  }
}

class VerifierRepairProvider implements LlmProvider {
  private verifierCalls = 0;

  async generateStructured<T>(input: LlmRequest, schema: unknown): Promise<T> {
    const name = schemaName(schema);
    if (name === "initial-reasoning-decision") {
      return {
        understanding: understanding("workspace_question", "inspect_explain"),
        step: {
          id: "read_manifest_first",
          kind: "tool_batch",
          rationale: "Start with a structural file.",
          toolRequests: [{ id: "read_manifest_for_beacon", kind: "read_file", path: "package.json", reason: "Inspect initial project evidence." }],
          missingFacts: ["Beacon destination."],
          successCriteria: ["Answer from source."]
        }
      } as T;
    }
    if (name === "answer-verification") {
      this.verifierCalls += 1;
      if (this.verifierCalls === 1) {
        return {
          verdict: "needs_more_evidence",
          rationale: "The answer has no source evidence.",
          supportedClaims: [],
          unsupportedClaims: ["The beacon probably stores the payload locally."],
          missingFacts: ["Read the beacon implementation."],
          evidenceRefs: []
        } as T;
      }
      return passingVerification(input) as T;
    }
    if (name === "reasoning-step") {
      const context = input.context as { toolResults: Array<{ kind: string }>; allowedEvidenceIds: string[]; validationErrors: string[] };
      if (context.toolResults.length === 1 && !context.validationErrors.length) {
        return finalBeaconStep([context.allowedEvidenceIds.at(-1)!], "The beacon probably stores the payload locally.") as T;
      }
      if (context.toolResults.length === 1) {
        return {
          id: "read_after_verifier",
          kind: "tool_batch",
          rationale: "Read the implementation requested by the verifier.",
          toolRequests: [{ id: "read_beacon_after_verifier", kind: "read_file", path: "src/beacon.ts", reason: "Resolve the unsupported claim." }],
          missingFacts: ["Beacon destination."],
          successCriteria: ["Answer from source."]
        } as T;
      }
      return finalBeaconStep([context.allowedEvidenceIds.at(-1)!], "The beacon passes its payload to archiveRecord.") as T;
    }
    throw new Error(`Unexpected schema ${name}`);
  }

  async generateText(): Promise<string> {
    throw new Error("Unexpected text request");
  }
}

class OperationalRepairBudgetVerifierProvider implements LlmProvider {
  validationRepairReasoningSeen = false;
  textVerifierCalls = 0;
  private initialCalls = 0;
  private reasoningCalls = 0;
  private verifierCalls = 0;

  async generateStructured<T>(input: LlmRequest, schema: unknown): Promise<T> {
    const name = schemaName(schema);
    if (name === "initial-reasoning-decision") {
      this.initialCalls += 1;
      if (this.initialCalls === 1) {
        throw new Error("real_provider.invalid_json: forced initial routing failure");
      }
      return {
        understanding: understanding("workspace_question", "inspect_explain"),
        step: {
          id: "read_manifest_before_unsupported_answer",
          kind: "tool_batch",
          rationale: "Start with package metadata before inspecting source.",
          toolRequests: [{ id: "read_manifest_before_unsupported_answer", kind: "read_file", path: "package.json", reason: "Collect initial project evidence." }],
          missingFacts: ["Beacon implementation."],
          successCriteria: ["Answer from verified source evidence."]
        }
      } as T;
    }
    if (name === "reasoning-step") {
      this.reasoningCalls += 1;
      if (this.reasoningCalls === 1) {
        throw new Error("real_provider.invalid_json: forced reasoning-step failure");
      }
      const rawContext = input.context as {
        originalRequest?: {
          context?: unknown;
        };
        toolResults?: Array<{ kind: string }>;
        allowedEvidenceIds?: string[];
        validationErrors?: string[];
      };
      const context = (rawContext.originalRequest?.context ?? rawContext) as {
        toolResults: Array<{ kind: string }>;
        allowedEvidenceIds: string[];
        validationErrors: string[];
      };
      if (context.validationErrors.length && context.toolResults.length === 1) {
        this.validationRepairReasoningSeen = true;
        return {
          id: "read_beacon_after_budget_repairs",
          kind: "tool_batch",
          rationale: "The verifier rejected the unsupported claim, so read the implementation.",
          toolRequests: [{ id: "read_beacon_after_budget_repairs", kind: "read_file", path: "src/beacon.ts", reason: "Resolve the verifier's missing fact." }],
          missingFacts: ["Beacon destination."],
          successCriteria: ["Answer from source evidence."]
        } as T;
      }
      if (context.toolResults.length === 1) {
        return finalBeaconStep([context.allowedEvidenceIds.at(-1)!], "The package metadata proves the beacon stores the payload locally.") as T;
      }
      return finalBeaconStep([context.allowedEvidenceIds.at(-1)!], "The beacon passes its payload to archiveRecord.") as T;
    }
    if (name === "answer-verification") {
      this.verifierCalls += 1;
      if (this.verifierCalls === 1) {
        return { verdict: "pass" } as T;
      }
      return passingVerification(input) as T;
    }
    throw new Error(`Unexpected schema ${name}`);
  }

  async generateText(input: LlmRequest): Promise<string> {
    if (input.purpose !== "verify") throw new Error("Unexpected text request");
    this.textVerifierCalls += 1;
    return "NEEDS_MORE_EVIDENCE\nRead src/beacon.ts to verify the beacon destination.";
  }
}

class VerifierComposeRepairProvider implements LlmProvider {
  readonly schemas: string[] = [];
  reasoningCallsAfterCompose = 0;
  private composeCalls = 0;
  private verifierCalls = 0;

  async generateStructured<T>(input: LlmRequest, schema: unknown): Promise<T> {
    const name = schemaName(schema);
    this.schemas.push(name);
    if (name === "initial-reasoning-decision") {
      return {
        understanding: understanding("workspace_question", "inspect_explain"),
        step: {
          id: "read_readme_for_verifier_compose_repair",
          kind: "tool_batch",
          rationale: "Read the project overview before composing.",
          toolRequests: [{ id: "read_readme_for_verifier_compose_repair", kind: "read_file", path: "README.md", reason: "Read the project overview." }],
          missingFacts: [],
          successCriteria: ["Answer from README evidence."]
        }
      } as T;
    }
    if (name === "reasoning-step") {
      if (this.composeCalls > 0) this.reasoningCallsAfterCompose += 1;
      return {
        id: "compose_from_readme_after_verifier",
        kind: "final",
        rationale: "Compose from README.",
        toolRequests: [],
        missingFacts: [],
        successCriteria: ["Use README evidence."]
      } satisfies ReasoningStep as T;
    }
    if (name === "provider-authored-result") {
      this.composeCalls += 1;
      const context = input.context as { allowedEvidenceRefs: string[]; validationErrors?: string[] };
      const evidenceId = context.allowedEvidenceRefs[0]!;
      if (this.composeCalls === 1) {
        return {
          decision: "ANSWER",
          answerMarkdown: "The project is an orchestration-first coding system and it has realtime collaborative editing.",
          claims: [
            { id: "supported_goal", text: "The project is an orchestration-first coding system.", material: true, evidenceIds: [evidenceId], confidence: "high" },
            { id: "unsupported_realtime", text: "It has realtime collaborative editing.", material: true, evidenceIds: [evidenceId], confidence: "high" }
          ],
          evidenceRefs: [evidenceId],
          unknowns: [],
          rationale: "First compose intentionally includes an unsupported claim."
        } satisfies ProviderAuthoredResult as T;
      }
      assert.ok(context.validationErrors?.some((error) => /unsupported|verifier/i.test(error)));
      return {
        decision: "ANSWER",
        answerMarkdown: "The project is an orchestration-first multi-agent coding system with durable repository memory.",
        claims: [{ id: "supported_repaired_goal", text: "The project is an orchestration-first multi-agent coding system with durable repository memory.", material: true, evidenceIds: [evidenceId], confidence: "high" }],
        evidenceRefs: [evidenceId],
        unknowns: ["The supplied evidence does not establish realtime collaborative editing."],
        rationale: "Verifier feedback removed unsupported claims."
      } satisfies ProviderAuthoredResult as T;
    }
    if (name === "answer-verification") {
      this.verifierCalls += 1;
      if (this.verifierCalls === 1) {
        return {
          verdict: "fail",
          rationale: "The realtime collaboration claim is unsupported by README evidence.",
          supportedClaims: ["The project is an orchestration-first coding system."],
          unsupportedClaims: ["It has realtime collaborative editing."],
          missingFacts: [],
          evidenceRefs: []
        } as T;
      }
      return passingVerification(input) as T;
    }
    throw new Error(`Unexpected schema ${name}`);
  }

  async generateText(): Promise<string> {
    throw new Error("Unexpected text request");
  }
}

class HybridSemanticProvider implements LlmProvider {
  async generateStructured<T>(input: LlmRequest, schema: unknown): Promise<T> {
    const name = schemaName(schema);
    if (name === "initial-reasoning-decision") {
      return {
        understanding: understanding("workspace_question", "inspect_explain"),
        step: {
          id: "semantic_lookup",
          kind: "tool_batch",
          rationale: "Use semantic retrieval because the question paraphrases implementation names.",
          toolRequests: [{ id: "semantic_payload", kind: "semantic_search", query: "travelling payload finally rest", reason: "Find the concept without relying on symbol words." }],
          missingFacts: ["Destination implementation."],
          successCriteria: ["Find semantically related source."]
        }
      } as T;
    }
    if (name === "reasoning-step") {
      const context = input.context as { toolResults: Array<{ data?: { nodes?: Array<{ path?: string }> } }>; allowedEvidenceIds: string[] };
      const beaconFound = context.toolResults[0]?.data?.nodes?.some((node) => node.path === "src/beacon.ts");
      if (!beaconFound) throw new Error("semantic vector retrieval did not find beacon source");
      return finalBeaconStep([context.allowedEvidenceIds.at(-1)!], "The payload reaches the archive implementation.") as T;
    }
    if (name === "answer-verification") return passingVerification(input) as T;
    throw new Error(`Unexpected schema ${name}`);
  }

  async generateText(): Promise<string> {
    throw new Error("Unexpected text request");
  }

  async embed(input: { inputs: string[]; model?: string }) {
    return {
      model: input.model ?? "test-semantic",
      vectors: input.inputs.map((value) => /travelling payload finally rest|beacon|archive/i.test(value) ? [1, 0] : [0, 1])
    };
  }
}

class DelegationProvider implements LlmProvider {
  async generateStructured<T>(input: LlmRequest, schema: unknown): Promise<T> {
    const name = schemaName(schema);
    if (name === "initial-reasoning-decision") {
      return {
        understanding: {
          ...understanding("workspace_question", "swarm_readonly"),
          risk: "high"
        },
        step: {
          id: "delegate_beacon",
          kind: "tool_batch",
          rationale: "Delegate a bounded read-only review.",
          toolRequests: [{ id: "delegate_beacon_review", kind: "delegate_readonly", query: "beacon flow", reason: "Cross-check the flow." }],
          missingFacts: ["Independent review."],
          successCriteria: ["Receive review evidence."]
        }
      } as T;
    }
    if (name === "reasoning-step") {
      const evidenceId = (input.context as { allowedEvidenceIds: string[] }).allowedEvidenceIds[0]!;
      return finalBeaconStep([evidenceId], "A read-only specialist traced unusualBeacon to archiveRecord.") as T;
    }
    if (name === "answer-verification") return passingVerification(input) as T;
    throw new Error(`Unexpected schema ${name}`);
  }

  async generateText(): Promise<string> {
    throw new Error("Unexpected text request");
  }
}

class NoMatchRecoveryProvider implements LlmProvider {
  async generateStructured<T>(input: LlmRequest, schema: unknown): Promise<T> {
    const name = schemaName(schema);
    if (name === "initial-reasoning-decision") {
      return {
        understanding: understanding("workspace_question", "inspect_explain"),
        step: {
          id: "search_unknown",
          kind: "tool_batch",
          rationale: "Try the paraphrased term.",
          toolRequests: [{ id: "search_unknown_term", kind: "repository_search", reason: "Locate the concept.", query: "phrase-that-does-not-exist" }],
          missingFacts: ["Relevant paths."],
          successCriteria: ["Discover candidate paths."]
        }
      } as T;
    }
    if (name === "reasoning-step") {
      const context = input.context as { toolResults: Array<{ kind: string; status: string }>; allowedEvidenceIds: string[] };
      if (context.toolResults.length === 1) {
        assert.equal(context.toolResults[0]?.status, "unavailable");
        return {
          id: "list_after_no_match",
          kind: "tool_batch",
          rationale: "Continue discovery with a workspace listing.",
          toolRequests: [{ id: "list_after_no_match", kind: "list_files", reason: "Discover candidate paths." }],
          missingFacts: [],
          successCriteria: []
        } as T;
      }
      return {
        id: "follow_up_after_listing",
        kind: "ask_user",
        rationale: "The repository was explored and the intended concept remains ambiguous.",
        toolRequests: [],
        missingFacts: ["The intended concept."],
        successCriteria: [],
        result: {
          decision: "FOLLOW_UP",
          answerMarkdown: "Which project concept do you mean?",
          claims: [],
          evidenceRefs: context.allowedEvidenceIds,
          unknowns: ["The intended concept is ambiguous."],
          rationale: "Safe tools could not resolve user intent."
        }
      } as T;
    }
    throw new Error(`Unexpected schema ${name}`);
  }

  async generateText(): Promise<string> {
    throw new Error("Unexpected text request");
  }
}

function finalBeaconStep(evidenceIds: string[], answer: string) {
  return {
    id: `final_beacon_${evidenceIds.length}`,
    kind: "final",
    rationale: "Answer the beacon question.",
    toolRequests: [],
    missingFacts: [],
    successCriteria: [],
    result: {
      decision: "ANSWER",
      answerMarkdown: answer,
      claims: evidenceIds.length ? [{ id: "beacon_claim", text: answer, material: true, evidenceIds, confidence: "high" }] : [],
      evidenceRefs: evidenceIds,
      unknowns: [],
      rationale: "Provider-authored answer."
    }
  };
}

function passingVerification(input: LlmRequest) {
  const context = input.context as { result: ProviderAuthoredResult; allowedEvidenceIds: string[] };
  return {
    verdict: "pass",
    rationale: "The material claims are supported.",
    supportedClaims: context.result.claims.map((claim) => typeof claim === "string" ? claim : claim.text),
    unsupportedClaims: [],
    missingFacts: [],
    evidenceRefs: context.allowedEvidenceIds
  };
}

function duplicateListStep(id: string): ReasoningStep {
  return {
    id,
    kind: "tool_batch",
    rationale: "Discover workspace files.",
    toolRequests: [{ id: `${id}_request`, kind: "list_files", reason: "Discover workspace files." }],
    missingFacts: ["Relevant source files."],
    successCriteria: ["Inspect the workspace once."]
  };
}

function understanding(intentKind: TurnUnderstanding["intentKind"], route: TurnUnderstanding["route"]): TurnUnderstanding {
  const needsWorkspace = intentKind !== "direct_conversation";
  return {
    originalRequest: "request",
    cleanedRequest: "request",
    language: "english",
    intentKind,
    route,
    needsWorkspace,
    goal: needsWorkspace ? "Investigate the workspace." : "Answer the user directly.",
    ambiguities: [],
    requiredEvidence: needsWorkspace ? ["source"] : [],
    risk: intentKind === "workspace_question" ? "medium" : needsWorkspace ? "high" : "low",
    confidence: "high",
    rationale: needsWorkspace ? "The request requires workspace evidence." : "The request can be answered directly."
  };
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "hivo-adaptive-reasoning-"));
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }), "utf8");
  await writeFile(path.join(root, "src", "beacon.ts"), "export function unusualBeacon(payload: string) { return archiveRecord(payload); }\nfunction archiveRecord(value: string) { return value; }\n", "utf8");
  return root;
}

function schemaName(schema: unknown) {
  return typeof schema === "object" && schema && "name" in schema ? String((schema as { name: string }).name) : "";
}
