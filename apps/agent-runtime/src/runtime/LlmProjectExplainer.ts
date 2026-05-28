import type { ProjectExplainEvidenceRef, ProjectExplainReport, ProjectExplainSection } from "@hivo/protocol";
import type { LlmProvider } from "../llm/LlmProvider.js";
import { projectExplainSchema } from "../schemas/sessionSchemas.js";
import {
  analyzeProjectQuestionGrounding,
  answerSatisfiesRequestedStyle,
  createConceptEvidenceGroupCoverage,
  createDeterministicGroundedFallbackAnswer,
  createDeterministicNotFoundAnswer,
  createGroundingPackText,
  createStyleInstruction,
  evidenceItemSupportsConcept,
  evidenceItemSupportsPageInventory,
  findUnsupportedDomainClaims,
  isForecastingScopeConcept,
  isPageInventoryConcept,
  isThresholdInventoryConcept,
  selectGroundingEvidenceRefs,
  type GroundingEvidenceItem,
  type ProjectQuestionGrounding
} from "./ProjectQuestionGrounding.js";
import {
  createWorkspaceReasoningPrompt,
  evidenceItemsForWorkspaceReasoning,
  responseLooksOffIntent
} from "./WorkspaceReasoningPipeline.js";

export type ProjectExplainLlmResponse = {
  answerMarkdown: string;
  usedEvidenceRefs: string[];
  unsupportedOrUnclearParts: string[];
};

export type ProjectExplainResult = ProjectExplainLlmResponse & {
  revisionCount: number;
  validationWarnings: string[];
  grounding: ProjectQuestionGrounding;
  fallbackUsed: boolean;
  fallbackReason?: string;
};

type EvidenceItem = GroundingEvidenceItem & {
  ref: string;
  markdownLink: string;
  path: string;
  line: number;
  title: string;
  reason: string;
  snippet?: string;
};

const MAX_EVIDENCE_ITEMS = 120;
const MAX_SNIPPET_CHARS = 700;

export async function explainProjectWithLlm(input: {
  provider: LlmProvider;
  userPrompt: string;
  report: ProjectExplainReport;
}): Promise<ProjectExplainResult> {
  const evidenceItems = createEvidenceItems(input.report);
  const grounding = analyzeProjectQuestionGrounding(input.userPrompt, input.report, evidenceItems);
  if (grounding.concept.specific && !grounding.conceptFound) {
    return {
      answerMarkdown: createDeterministicNotFoundAnswer(grounding),
      usedEvidenceRefs: selectGroundingEvidenceRefs(grounding, evidenceItems),
      unsupportedOrUnclearParts: [`Requested concept not found in current workspace evidence: ${grounding.concept.label}`],
      revisionCount: 0,
      validationWarnings: grounding.unknowns,
      grounding,
      fallbackUsed: true,
      fallbackReason: "concept_not_found_without_provider_answer"
    };
  }

  const firstRequest = createExplainRequest(input.userPrompt, input.report, evidenceItems, grounding);
  let first: ProjectExplainLlmResponse;
  try {
    first = await input.provider.generateStructured<ProjectExplainLlmResponse>(firstRequest, projectExplainSchema);
  } catch (error) {
    return createProviderFailureFallback(grounding, evidenceItems, error, 0);
  }
  const firstValidation = validateProjectExplainResponse(first, input.userPrompt, evidenceItems, grounding);
  if (firstValidation.valid) {
    return normalizeProjectExplainResponse(first, 0, firstValidation.warnings, grounding);
  }

  let revision: ProjectExplainLlmResponse;
  try {
    revision = await input.provider.generateStructured<ProjectExplainLlmResponse>(
      createRevisionRequest(input.userPrompt, input.report, evidenceItems, grounding, first, firstValidation.errors),
      projectExplainSchema
    );
  } catch (error) {
    return createProviderFailureFallback(grounding, evidenceItems, error, 1, firstValidation.errors);
  }
  const revisionValidation = validateProjectExplainResponse(revision, input.userPrompt, evidenceItems, grounding);
  if (revisionValidation.valid) {
    return normalizeProjectExplainResponse(revision, 1, revisionValidation.warnings, grounding);
  }

  const validationErrors = [
    ...firstValidation.errors,
    ...revisionValidation.errors
  ];
  return {
    answerMarkdown: createDeterministicGroundedFallbackAnswer(grounding, validationErrors),
    usedEvidenceRefs: selectGroundingEvidenceRefs(grounding, evidenceItems),
    unsupportedOrUnclearParts: validationErrors,
    revisionCount: 1,
    validationWarnings: revisionValidation.warnings,
    grounding,
    fallbackUsed: true,
    fallbackReason: "provider_answer_failed_local_validation"
  };
}

function createProviderFailureFallback(
  grounding: ProjectQuestionGrounding,
  evidenceItems: EvidenceItem[],
  error: unknown,
  revisionCount: number,
  priorValidationErrors: string[] = []
): ProjectExplainResult {
  const providerError = `Provider failed during project explanation: ${formatProviderError(error)}`;
  const validationErrors = [...priorValidationErrors, providerError];
  return {
    answerMarkdown: createDeterministicGroundedFallbackAnswer(grounding, validationErrors),
    usedEvidenceRefs: selectGroundingEvidenceRefs(grounding, evidenceItems),
    unsupportedOrUnclearParts: validationErrors,
    revisionCount,
    validationWarnings: [...grounding.unknowns, providerError],
    grounding,
    fallbackUsed: true,
    fallbackReason: providerError
  };
}

function createExplainRequest(
  userPrompt: string,
  report: ProjectExplainReport,
  evidenceItems: EvidenceItem[],
  grounding: ProjectQuestionGrounding
) {
  return {
    systemPrompt: createSystemPrompt(grounding),
    userPrompt: [
      "User prompt:",
      userPrompt,
      "",
      "Grounding gate:",
      createGroundingPackText(grounding),
      "",
      createWorkspaceReasoningPrompt(grounding.workspaceReasoning),
      "",
      "Project evidence pack:",
      createEvidencePackText(report, evidenceItems, grounding),
      "",
      "Return strict JSON with this exact shape:",
      JSON.stringify({
        answerMarkdown: "Markdown answer that directly answers the user's prompt.",
        usedEvidenceRefs: ["path/to/file.ext:line"],
        unsupportedOrUnclearParts: ["Any claim the evidence does not prove, or an empty array."]
      }, null, 2)
    ].join("\n")
  };
}

function createRevisionRequest(
  userPrompt: string,
  report: ProjectExplainReport,
  evidenceItems: EvidenceItem[],
  grounding: ProjectQuestionGrounding,
  previous: ProjectExplainLlmResponse,
  errors: string[]
) {
  return {
    systemPrompt: createSystemPrompt(grounding),
    userPrompt: [
      "Revise the previous project explanation. It failed local validation.",
      "",
      "Validation errors:",
      ...errors.map((error) => `- ${error}`),
      "",
      "Original user prompt:",
      userPrompt,
      "",
      "Grounding gate:",
      createGroundingPackText(grounding),
      "",
      createWorkspaceReasoningPrompt(grounding.workspaceReasoning),
      "",
      "Previous response:",
      JSON.stringify(previous, null, 2),
      "",
      "Project evidence pack:",
      createEvidencePackText(report, evidenceItems, grounding),
      "",
      "Return corrected strict JSON only."
    ].join("\n")
  };
}

function createSystemPrompt(grounding: ProjectQuestionGrounding) {
  return [
    "You are the only reasoning layer for a production project explanation feature.",
    "Use the unified workspace intent and evidence facets as the primary request understanding.",
    "Do not use memorized project categories, canned domain labels, or template stories.",
    "Infer what the project does only from the supplied evidence pack and the user's exact prompt.",
    `Question kind: ${grounding.questionKind}. Do not answer using a different specialized flow from an earlier turn.`,
    `Unified intent: actionMode=${grounding.workspaceReasoning.intent.actionMode}, answerGoal=${grounding.workspaceReasoning.intent.answerGoal}, topicPhrase=${grounding.workspaceReasoning.intent.topicPhrase}, outputShape=${grounding.workspaceReasoning.intent.outputShape}.`,
    `Required evidence facets: ${grounding.workspaceReasoning.intent.requiredFacets.join(", ") || "none"}.`,
    grounding.projectContextRequired
      ? "The user is asking about how something works inside this project. First state what the current project appears to be from project-domain refs, then answer the exact requested concept."
      : "Answer the user's specific question first. Do not default to a broad project overview unless the user asked for one.",
    `Requested answer style: ${grounding.style}. ${createStyleInstruction(grounding.style)}`,
    grounding.style === "detailed" || grounding.workspaceReasoning.intent.outputShape === "walkthrough"
      ? "For detailed walkthroughs: use multiple named sections, explain each proven step in several sentences, cite concrete files/functions/endpoints, and avoid returning only a short bullet list."
      : "",
    `Project domain candidate: ${grounding.projectDomain.label} (${grounding.projectDomain.confidence}). Use it only if you cite its project-domain refs.`,
    grounding.concept.specific
      ? `Requested concept: ${grounding.concept.label}. Only explain this concept using the listed concept-supporting refs.`
      : "This is a general project explanation. Do not invent project name, users, business purpose, or domain unless the evidence states it.",
    `Requested answer shape: ${grounding.answerShape}. ${createAnswerShapeInstruction(grounding.answerShape)}`,
    isThresholdInventoryConcept(grounding) && grounding.answerShape === "inventory_table"
      ? "For threshold, formula, or numeric comparison questions: extract the concrete numbers, comparisons, formulas, branches, and actions into a useful table. Every number must have a cited ref."
      : "",
    isForecastingScopeConcept(grounding)
      ? "For forecasting questions: identify the proven forecasting type, inputs, outputs, and whether the scope is per-customer or aggregate/global. Say 'not proven' for scope if refs do not show it."
      : "",
    isPageInventoryConcept(grounding)
      ? "For page/screen inventory questions: inspect UI entrypoints, routes, nav/sidebar, sections, tabs, and rendered components first. Classify each item as route/page/section/tab/component. CSS or page titles are styling/context only and must never be counted as pages. Include what each item does, confidence, and UI evidence refs. Do not give threshold, formula, or forecasting tables unless the user asked for those."
      : "",
    grounding.workspaceReasoning.intent.requiredFacets.includes("algorithms_models")
      ? "For algorithm/model questions: distinguish actual algorithms/models from service wrappers, managers, and UI labels. If the user asks how one algorithm works, synthesize role, inputs, labels/training, prediction/use site, and related explainability from code refs instead of dumping snippets."
      : "",
    "For realtime claims, distinguish true realtime streams/sockets/consumers from polling/timers/repeated refresh. Say 'not proven' when the evidence does not prove either.",
    "Every factual claim about code behavior must be grounded in one of the provided refs.",
    "If a concept or project identity is not proven by the current workspace evidence, say you cannot confirm it instead of guessing.",
    "Use only provided hivo-file links. Do not invent file paths, line numbers, tools, or run commands.",
    "If evidence conflicts with the user's project name or idea, explain the conflict instead of forcing a label.",
    "Return strict JSON only. Do not wrap it in markdown."
  ].join("\n");
}

function createAnswerShapeInstruction(shape: ProjectQuestionGrounding["answerShape"]) {
  if (shape === "inventory_table") {
    return "Use a compact table when it helps list many values, comparisons, formulas, or conditions.";
  }
  if (shape === "detailed_walkthrough") {
    return "Use a structured walkthrough, but keep it grounded and avoid unrelated architecture dumps.";
  }
  return "Use concise prose. Do not add a table unless the user explicitly asked for an inventory, comparison, formulas, or many numbers.";
}

function createEvidencePackText(report: ProjectExplainReport, evidenceItems: EvidenceItem[], grounding: ProjectQuestionGrounding) {
  const moduleLines = report.moduleMap.slice(0, 12).map((module) => {
    const files = module.importantFiles.slice(0, 5).join(", ") || "no important files captured";
    return `- ${module.root}: ${module.responsibility}; files: ${files}`;
  });
  const evidenceLines = evidenceItems.map((item) => {
    const snippet = item.snippet ? `\n  snippet:\n${indent(trimText(item.snippet, MAX_SNIPPET_CHARS), "  ")}` : "";
    return [
      `- ref: ${item.ref}`,
      `  link: ${item.markdownLink}`,
      `  title: ${item.title}`,
      `  reason: ${item.reason}`,
      snippet
    ].filter(Boolean).join("\n");
  });
  return [
    `Overview: ${report.overview}`,
    `Architecture: ${report.architecture}`,
    `Data flow summary: ${report.dataFlow}`,
    `Entry points: ${report.entryPoints.join(", ") || "none proven"}`,
    `Important files: ${report.importantFiles.slice(0, 20).join(", ") || "none"}`,
    `Run commands found: ${report.howToRun.join(", ") || "none"}`,
    `Risks/unknowns: ${report.risksAndUnknowns.join(" | ") || "none recorded"}`,
    "",
    "Module map:",
    ...(moduleLines.length ? moduleLines : ["- none"]),
    "",
    "Internal read-only understanding lanes:",
    `- Project Mapper: ${grounding.understanding.projectMapperSummary}`,
    `- Data Flow Mapper: ${grounding.understanding.dataFlowSummary}`,
    `- Concept Specialist: ${grounding.concept.specific ? `${grounding.concept.label}; refs ${grounding.supportingRefs.join(", ") || "none"}` : "general project explanation"}`,
    `- Grounding Skeptic: project-domain refs ${grounding.projectDomain.evidenceRefs.join(", ") || "none"}; validation refs ${grounding.understanding.validationEvidence.slice(0, 10).map((item) => item.ref).join(", ") || "none"}`,
    "",
    "Allowed evidence refs and links:",
    ...(evidenceLines.length ? evidenceLines : ["- none"])
  ].join("\n");
}

function createEvidenceItems(report: ProjectExplainReport): EvidenceItem[] {
  const byRef = new Map<string, EvidenceItem>();
  const sectionCountsByFile = new Map<string, number>();
  const addSection = (section: ProjectExplainSection) => {
    const sectionCount = sectionCountsByFile.get(section.filePath) ?? 0;
    if (sectionCount >= 10) return;
    sectionCountsByFile.set(section.filePath, sectionCount + 1);
    const ref = normalizeRef(section.filePath, section.lineStart);
    const existing = byRef.get(ref);
    if (existing) {
      if (!existing.snippet && section.snippet) existing.snippet = section.snippet;
      if (!existing.reason && (section.whyItMatters || section.explanation)) existing.reason = section.whyItMatters || section.explanation;
      if (!existing.title && section.title) existing.title = section.title;
      return;
    }
    byRef.set(ref, {
      ref,
      markdownLink: formatFileLineLink(section.filePath, section.lineStart),
      path: section.filePath,
      line: section.lineStart,
      title: section.title,
      reason: section.whyItMatters || section.explanation,
      snippet: section.snippet
    });
  };
  const addEvidence = (evidence: ProjectExplainEvidenceRef) => {
    if (evidence.type === "directory") return;
    const line = evidence.lineStart ?? 1;
    const ref = normalizeRef(evidence.path, line);
    const existing = byRef.get(ref);
    if (existing) {
      if (!existing.snippet && (evidence.snippet ?? evidence.excerpt)) existing.snippet = evidence.snippet ?? evidence.excerpt;
      if (!existing.reason && evidence.reason) existing.reason = evidence.reason;
      if (!existing.title && evidence.symbol) existing.title = evidence.symbol;
      return;
    }
    byRef.set(ref, {
      ref,
      markdownLink: formatFileLineLink(evidence.path, line),
      path: evidence.path,
      line,
      title: evidence.symbol ?? evidence.type,
      reason: evidence.reason,
      snippet: evidence.snippet ?? evidence.excerpt
    });
  };
  for (const evidence of report.evidence) {
    if (/arima|forecast|trend|model|models|classifier|classification|cluster|clustering|algorithm|analytics|pipeline|shap|svm|kmeans|orchestrator|agents?|routes?|services|frontend|dashboard_ui|(^|\/)src\/app\/|pages|screens|views|components|app\.(jsx|tsx|js|ts)|index\.html/i.test(evidence.path)) {
      addEvidence(evidence);
    }
  }
  for (const section of report.sections) addSection(section);
  for (const evidence of report.evidence) addEvidence(evidence);
  for (const module of report.moduleMap) {
    for (const evidence of module.evidence) addEvidence(evidence);
  }
  return [...byRef.values()].slice(0, MAX_EVIDENCE_ITEMS);
}

function validateProjectExplainResponse(
  response: ProjectExplainLlmResponse,
  userPrompt: string,
  evidenceItems: EvidenceItem[],
  grounding: ProjectQuestionGrounding
) {
  const errors: string[] = [];
  const warnings: string[] = [];
  const allowedRefs = new Set(evidenceItems.map((item) => item.ref));
  const conceptSupportingRefs = new Set(grounding.supportingRefs);
  if (!response || typeof response !== "object") {
    return { valid: false, errors: ["response must be an object"], warnings };
  }
  if (typeof response.answerMarkdown !== "string" || response.answerMarkdown.trim().length < 40) {
    errors.push("answerMarkdown must be a non-empty, useful answer.");
  }
  if (!Array.isArray(response.usedEvidenceRefs)) {
    errors.push("usedEvidenceRefs must be an array.");
  } else {
    for (const ref of response.usedEvidenceRefs) {
      if (typeof ref !== "string" || !allowedRefs.has(normalizeRefString(ref))) {
        errors.push(`usedEvidenceRefs contains an unknown ref: ${String(ref)}`);
      }
    }
  }
  if (!Array.isArray(response.unsupportedOrUnclearParts)) {
    errors.push("unsupportedOrUnclearParts must be an array.");
  }
  const linkedRefs = extractOrchcodeRefs(response.answerMarkdown ?? "");
  for (const ref of linkedRefs) {
    if (!allowedRefs.has(ref)) {
      errors.push(`answerMarkdown contains an unknown hivo-file ref: ${ref}`);
    }
  }
  if (evidenceItems.length && linkedRefs.length === 0) {
    errors.push("answerMarkdown must include at least one provided hivo-file link.");
  }
  const citedRefs = uniqueStrings([
    ...linkedRefs,
    ...(Array.isArray(response.usedEvidenceRefs) ? response.usedEvidenceRefs.map((ref) => typeof ref === "string" ? normalizeRefString(ref) : "") : [])
  ]);
  if (responseLooksOffIntent(response.answerMarkdown ?? "", grounding.workspaceReasoning)) {
    errors.push(`answer appears to follow the wrong flow for topic: ${grounding.workspaceReasoning.intent.topicPhrase}`);
  }
  const primaryEvidenceRefs = new Set(evidenceItemsForWorkspaceReasoning(grounding.workspaceReasoning).map((item) => item.ref));
  if (grounding.workspaceReasoning.intent.requiredFacets.length && citedRefs.length && !citedRefs.some((ref) => primaryEvidenceRefs.has(ref))) {
    warnings.push(`answer did not cite the top unified workspace evidence for topic: ${grounding.workspaceReasoning.intent.topicPhrase}`);
  }
  if (grounding.concept.specific) {
    const citedItems = citedRefs
      .map((ref) => evidenceItems.find((candidate) => candidate.ref === ref))
      .filter((item): item is EvidenceItem => Boolean(item));
    const expandedCitedItems = expandCitedEvidenceItems(citedItems, evidenceItems);
    if (!grounding.conceptFound) {
      errors.push(`requested concept was not found in the current workspace evidence: ${grounding.concept.label}`);
    } else if (!expandedCitedItems.some((item) => conceptSupportingRefs.has(item.ref))) {
      errors.push(`answer must cite evidence that directly supports the requested concept: ${grounding.concept.label}`);
    }
    if (grounding.concept.evidenceGroups?.length) {
      const citedCoverage = createConceptEvidenceGroupCoverage(grounding.concept, expandedCitedItems);
      const missingGroups = citedCoverage.filter((group) => !group.found).map((group) => group.label);
      if (missingGroups.length) {
        errors.push(`answer citations must cover requested evidence group(s): ${missingGroups.join(", ")}`);
      }
    }
    if (isThresholdInventoryConcept(grounding)) {
      if (!expandedCitedItems.some(citationHasNumericSupport)) {
        errors.push("threshold answers must cite current-workspace lines that contain numeric comparisons, constants, weights, or formulas.");
      }
    }
    if (isForecastingScopeConcept(grounding)) {
      if (!expandedCitedItems.some((item) => /\b(forecast|forecasting|arima|sarima|trend|prediction|delta|deviation)\b/i.test(evidenceItemText(item)))) {
        errors.push("forecasting answers must cite current-workspace lines that support the forecasting type or trend logic.");
      }
    }
    if (isPageInventoryConcept(grounding)) {
      if (!expandedCitedItems.some((item) => evidenceItemSupportsPageInventory(item))) {
        errors.push("page inventory answers must cite current-workspace UI route, navigation, view, or section evidence.");
      }
      if (!answerMentionsPageInventory(response.answerMarkdown ?? "")) {
        errors.push("page inventory answers must actually discuss pages, screens, views, routes, or sections.");
      }
      if (!answerExplainsPageFunctions(response.answerMarkdown ?? "")) {
        errors.push("page inventory answers must describe what each page, screen, view, route, or section does.");
      }
      if (answerLooksLikeWrongSpecializedFlow(response.answerMarkdown ?? "", "page_inventory")) {
        errors.push("page inventory answers must not answer with thresholds, formulas, forecasting, or unrelated numeric inventories.");
      }
      if (citedItems.length && !expandedCitedItems.some((item) => pageInventoryCitationHasStructuralSupport(item))) {
        errors.push("page inventory citations must include real route, nav, tab, or section structure, not only CSS, titles, package files, or generic docs.");
      }
    }
    for (const ref of citedRefs.filter(Boolean)) {
      const item = evidenceItems.find((candidate) => candidate.ref === ref);
      if (item && !evidenceItemSupportsConcept(item, grounding.concept) && answerMentionsRequestedConcept(response.answerMarkdown ?? "", grounding)) {
        warnings.push(`citation ${ref} does not itself support ${grounding.concept.label}; another cited ref must carry that claim.`);
      }
    }
  }
  if (grounding.projectContextRequired && grounding.projectDomain.confidence !== "unknown" && grounding.projectDomain.label !== "unknown") {
    const domainRefs = new Set(grounding.projectDomain.evidenceRefs);
    const domainSourceRefs = new Set(grounding.projectDomain.sourceEvidenceRefs);
    const mentionsDomain = answerMentionsProjectDomain(response.answerMarkdown ?? "", grounding);
    if (!mentionsDomain) {
      errors.push(`answer must explain the current project identity/domain before the focused concept: ${grounding.projectDomain.label}`);
    }
    if (!citedRefs.some((ref) => domainRefs.has(ref))) {
      errors.push(`answer must cite current-workspace evidence for project identity/domain: ${grounding.projectDomain.label}`);
    }
    if (domainSourceRefs.size && mentionsDomain && !citedRefs.some((ref) => domainSourceRefs.has(ref))) {
      errors.push(`answer must cite source evidence for project identity/domain when source evidence exists: ${grounding.projectDomain.label}`);
    }
  }
  const unsupportedDomainClaims = findUnsupportedDomainClaims(response.answerMarkdown ?? "", evidenceItems, grounding.concept);
  if (unsupportedDomainClaims.length) {
    errors.push(`answer mentions unsupported project/domain claim(s): ${unsupportedDomainClaims.join(", ")}`);
  }
  if (!answerSatisfiesRequestedStyle(response.answerMarkdown ?? "", grounding.style)) {
    errors.push(`answer does not preserve the requested ${grounding.style} style.`);
  }
  if ((grounding.style === "detailed" || grounding.workspaceReasoning.intent.outputShape === "walkthrough") && evidenceItems.length) {
    const answerText = response.answerMarkdown ?? "";
    const sectionCount = countDetailedAnswerSections(answerText);
    if (answerText.trim().length < 900 || sectionCount < 3) {
      errors.push(`detailed walkthrough answer is too shallow: ${answerText.trim().length} chars and ${sectionCount} section(s).`);
    }
    if (grounding.workspaceReasoning.intent.answerGoal === "trace_flow" && !/\b(def|function|class|endpoint|route|api|fit|predict|predict_proba|SVC|SHAP|joblib|pickle|train_|predict_)\b/i.test(answerText)) {
      errors.push("detailed flow answer must mention concrete functions, endpoints, or implementation symbols from the evidence.");
    }
  }
  if (!appearsToAnswerPrompt(response.answerMarkdown ?? "", userPrompt)) {
    errors.push("answerMarkdown does not appear to directly answer the user's prompt.");
  }
  return { valid: errors.length === 0, errors, warnings };
}

function normalizeProjectExplainResponse(
  response: ProjectExplainLlmResponse,
  revisionCount: number,
  validationWarnings: string[],
  grounding: ProjectQuestionGrounding
): ProjectExplainResult {
  return {
    answerMarkdown: response.answerMarkdown.trim(),
    usedEvidenceRefs: [...new Set(response.usedEvidenceRefs.map(normalizeRefString))],
    unsupportedOrUnclearParts: response.unsupportedOrUnclearParts.filter((entry) => typeof entry === "string" && entry.trim()),
    revisionCount,
    validationWarnings,
    grounding,
    fallbackUsed: false
  };
}

function createUnableToSafelyExplainMessage(userPrompt: string, report: ProjectExplainReport) {
  const arabic = /[\u0600-\u06ff]/.test(userPrompt);
  const evidence = report.evidence
    .filter((entry) => entry.type !== "directory")
    .slice(0, 5)
    .map((entry) => `- ${formatFileLineLink(entry.path, entry.lineStart ?? 1)}: ${entry.reason}`);
  if (arabic) {
    return [
      "\u0645\u0634 \u0647\u0637\u0644\u0639 \u0634\u0631\u062d \u062a\u062e\u0645\u064a\u0646\u064a \u0644\u0644\u0645\u0634\u0631\u0648\u0639 \u0644\u0623\u0646 \u0631\u062f \u0627\u0644\u0645\u0632\u0648\u062f \u0645\u0627\u0639\u062f\u0627\u0634 \u062a\u062d\u0642\u0642 \u0627\u0644\u0623\u062f\u0644\u0629 \u0627\u0644\u0645\u062d\u0644\u064a\u0629.",
      "",
      "\u062a\u0642\u0631\u064a\u0631 \u0627\u0644\u0642\u0631\u0627\u0621\u0629 \u0627\u062a\u062e\u0632\u0646 \u0648\u0641\u064a\u0647 \u0627\u0644\u0623\u062f\u0644\u0629 \u062f\u064a \u0643\u0628\u062f\u0627\u064a\u0629:",
      ...(evidence.length ? evidence : ["- \u0645\u0641\u064a\u0634 \u0623\u062f\u0644\u0629 \u0643\u0641\u0627\u064a\u0629 \u0645\u062d\u0641\u0648\u0638\u0629 \u0641\u064a \u0627\u0644\u062a\u0642\u0631\u064a\u0631."]),
      "",
      "\u062c\u0631\u0628 \u062a\u0633\u0623\u0644 \u0639\u0646 \u0645\u0644\u0641 \u0645\u062d\u062f\u062f \u0623\u0648 \u0634\u063a\u0644 \u0645\u0632\u0648\u062f \u0623\u0642\u0648\u0649 \u0644\u0648 \u0645\u062d\u062a\u0627\u062c \u062a\u0641\u0635\u064a\u0644 \u0623\u0643\u0628\u0631."
    ].join("\n");
    return [
      "مش هطلع شرح تخميني للمشروع لأن رد المزود ماعداش تحقق الأدلة المحلية.",
      "",
      "تقرير القراءة اتخزن وفيه الأدلة دي كبداية:",
      ...(evidence.length ? evidence : ["- مفيش أدلة كفاية محفوظة في التقرير."]),
      "",
      "جرب تسأل عن ملف محدد أو شغل مزود أقوى لو محتاج تفصيل أكبر."
    ].join("\n");
    return [
      "مش هطلع شرح تخميني للمشروع لأن رد الـ LLM ماعدّاش تحقق الأدلة المحلي.",
      "",
      "تقرير القراءة اتخزن وفيه الأدلة دي كبداية:",
      ...(evidence.length ? evidence : ["- مفيش أدلة كافية محفوظة في التقرير."]),
      "",
      "جرّب تشغيل نفس السؤال بمزوّد LLM أقوى أو اسأل عن ملف محدد."
    ].join("\n");
  }
  return [
    "I could not safely produce a grounded project explanation because the LLM response failed local evidence validation.",
    "",
    "The read-only evidence report was stored. Starting evidence:",
    ...(evidence.length ? evidence : ["- No enough evidence refs were stored in the report."]),
    "",
    "Try again with a stronger configured provider or ask about a specific file."
  ].join("\n");
}

function appearsToAnswerPrompt(answer: string, userPrompt: string) {
  const promptTerms = meaningfulTerms(userPrompt);
  if (!promptTerms.length) return true;
  const answerLower = answer.toLowerCase();
  return promptTerms.some((term) => answerLower.includes(term));
}

function answerMentionsRequestedConcept(answer: string, grounding: ProjectQuestionGrounding) {
  if (!grounding.concept.specific) return false;
  const answerLower = answer.toLowerCase();
  return [grounding.concept.label, ...grounding.concept.terms, ...grounding.concept.aliases]
    .some((term) => answerLower.includes(term.toLowerCase()));
}

function answerMentionsProjectDomain(answer: string, grounding: ProjectQuestionGrounding) {
  const domain = grounding.projectDomain;
  if (domain.confidence === "unknown" || domain.label === "unknown") return true;
  const answerLower = answer.toLowerCase();
  return [domain.label, ...domain.aliases]
    .filter((term) => term.trim().length > 2)
    .some((term) => answerLower.includes(term.toLowerCase()));
}

function answerLooksLikeWrongSpecializedFlow(answer: string, expected: ProjectQuestionGrounding["questionKind"]) {
  const normalized = answer.toLowerCase();
  if (expected === "page_inventory") {
    const pageMentions = /\b(page|pages|screen|screens|view|views|route|routes|nav|navigation|section|sections)\b|(?:\u0635\u0641\u062d|\u0634\u0627\u0634|\u0648\u0627\u062c\u0647)/i.test(answer);
    const thresholdMentions = /\b(threshold|thresholds|threshlod|score|formula|weight|cosine|membership|orchestrator|dispatch)\b|(?:\u0628\u0642\u0627\u0631\u0646|\u0623\u0631\u0642\u0627\u0645|\u0627\u0631\u0642\u0627\u0645|\u0645\u0639\u0627\u062f\u0644)/i.test(answer);
    return thresholdMentions && !pageMentions && (normalized.includes("| signal |") || normalized.includes("threshold"));
  }
  return false;
}

function answerMentionsPageInventory(answer: string) {
  return /\b(page|pages|screen|screens|view|views|route|routes|nav|navigation|section|sections)\b|(?:\u0635\u0641\u062d|\u0634\u0627\u0634|\u0648\u0627\u062c\u0647)/i.test(answer);
}

function answerExplainsPageFunctions(answer: string) {
  return /\b(does|shows|lists|renders|opens|handles|displays|contains|what it does)\b|(?:\u0628\u062a\u0639\u0645\u0644|\u0628\u064a\u0639\u0631\u0636|\u062a\u0639\u0631\u0636|\u0628\u064a\u0641\u062a\u062d|\u0628\u062a\u0641\u062a\u062d|\u0648\u0638\u064a\u0641|\u0627\u0644\u0648\u0638\u064a\u0641\u0629)/i.test(answer);
}

function pageInventoryCitationHasStructuralSupport(item: EvidenceItem) {
  const path = item.path.replaceAll("\\", "/").toLowerCase();
  if (/\.(css|scss|sass|less)$/i.test(path)) return false;
  if (/package\.json|requirements\.txt|pyproject\.toml|cargo\.toml|readme\.md$/i.test(path)) return false;
  return /\b(BrowserRouter|createBrowserRouter|Routes|Route|router|path\s*:|href=|data-view|data-page|CHAPTERS|PAGES|ROUTES|VIEWS|TABS)\b|<\s*(nav|section|aside|main|a|button)\b/i.test(item.snippet ?? "");
}

function citationHasNumericSupport(item: EvidenceItem) {
  return /-?\d+(?:\.\d+)?/.test(evidenceItemText(item))
    && (/\b(threshold|threshlod|cutoff|floor|min|max|minimum|maximum|score|weight|gap|cosine|membership|severity|trend|drift|accepted|f1|accuracy|delta|deviation|multiplier|guardrail|forecast|arima|sarima|orchestrator|dispatch|condition|rule)\b/i.test(evidenceItemText(item))
      || /[<>]=?|==/.test(evidenceItemText(item)));
}

function expandCitedEvidenceItems(citedItems: EvidenceItem[], evidenceItems: EvidenceItem[]) {
  const citedRefs = new Set(citedItems.map((item) => item.ref));
  const citedPaths = new Set(citedItems.map((item) => item.path.replaceAll("\\", "/").toLowerCase()));
  const nearby = evidenceItems.filter((item) => {
    if (citedRefs.has(item.ref)) return true;
    const normalizedPath = item.path.replaceAll("\\", "/").toLowerCase();
    if (!citedPaths.has(normalizedPath)) return false;
    return citedItems.some((cited) => Math.abs(cited.line - item.line) <= 4);
  });
  return uniqueEvidenceItems([...citedItems, ...nearby]);
}

function evidenceItemText(item: EvidenceItem) {
  return [item.path, item.title, item.reason, item.snippet ?? ""].join("\n");
}

function meaningfulTerms(text: string) {
  const stopWords = new Set([
    "the", "and", "for", "this", "that", "with", "from", "project", "explain",
    "اشرح", "شرح", "المشروع", "مشروع", "دا", "ده", "دي", "ازاي", "كيف", "ايه", "إيه", "من", "في", "على", "هو", "هي"
  ]);
  return [...text.toLowerCase().matchAll(/[\p{L}\p{N}_-]+/gu)]
    .map((match) => match[0])
    .filter((term) => term.length > 2 && !stopWords.has(term))
    .slice(0, 12);
}

function extractOrchcodeRefs(markdown: string) {
  const refs: string[] = [];
  for (const match of markdown.matchAll(/hivo-file:([^)\s]+):(\d+)/g)) {
    try {
      refs.push(normalizeRef(decodeURIComponent(match[1] ?? ""), Number(match[2])));
    } catch {
      refs.push(`${match[1] ?? ""}:${match[2] ?? ""}`);
    }
  }
  return refs;
}

function normalizeRefString(ref: string) {
  const match = ref.match(/^(.+):(\d+)$/);
  if (!match) return ref.trim();
  return normalizeRef(match[1] ?? "", Number(match[2]));
}

function normalizeRef(path: string, line: number) {
  return `${path.replaceAll("\\", "/")}:${line}`;
}

function formatFileLineLink(filePath: string, line: number) {
  return `[${filePath}:${line}](hivo-file:${encodeURIComponent(filePath)}:${line})`;
}

function trimText(value: string, maxChars: number) {
  return value.length > maxChars ? `${value.slice(0, maxChars - 3)}...` : value;
}

function formatProviderError(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error);
}

function indent(value: string, prefix: string) {
  return value.split(/\r?\n/).map((line) => `${prefix}${line}`).join("\n");
}

function countDetailedAnswerSections(answer: string) {
  const markdownHeadings = (answer.match(/^#{2,4}\s+/gm) ?? []).length;
  const boldHeadings = (answer.match(/^\*\*[^*\n]{3,80}\*\*/gm) ?? []).length;
  return markdownHeadings + boldHeadings;
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function uniqueEvidenceItems<T extends EvidenceItem>(items: T[]) {
  const byRef = new Map<string, T>();
  for (const item of items) {
    if (!byRef.has(item.ref)) byRef.set(item.ref, item);
  }
  return [...byRef.values()];
}
