import type { ProjectExplainEvidenceRef, ProjectExplainReport, ProjectExplainSection } from "@orchcode/protocol";
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
  findUnsupportedDomainClaims,
  selectGroundingEvidenceRefs,
  type GroundingEvidenceItem,
  type ProjectQuestionGrounding
} from "./ProjectQuestionGrounding.js";

export type ProjectExplainLlmResponse = {
  answerMarkdown: string;
  usedEvidenceRefs: string[];
  unsupportedOrUnclearParts: string[];
};

export type ProjectExplainResult = ProjectExplainLlmResponse & {
  revisionCount: number;
  validationWarnings: string[];
  grounding: ProjectQuestionGrounding;
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

const MAX_EVIDENCE_ITEMS = 60;
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
      grounding
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
    grounding
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
    grounding
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
    "Do not use memorized project categories, canned domain labels, or template stories.",
    "Infer what the project does only from the supplied evidence pack and the user's exact prompt.",
    grounding.projectContextRequired
      ? "The user is asking about how something works inside this project. First state what the current project appears to be from project-domain refs, then answer the exact requested concept."
      : "Answer the user's specific question first. Do not default to a broad project overview unless the user asked for one.",
    `Requested answer style: ${grounding.style}. ${createStyleInstruction(grounding.style)}`,
    `Project domain candidate: ${grounding.projectDomain.label} (${grounding.projectDomain.confidence}). Use it only if you cite its project-domain refs.`,
    grounding.concept.specific
      ? `Requested concept: ${grounding.concept.label}. Only explain this concept using the listed concept-supporting refs.`
      : "This is a general project explanation. Do not invent project name, users, business purpose, or domain unless the evidence states it.",
    "For realtime claims, distinguish true realtime streams/sockets/consumers from polling/timers/repeated refresh. Say 'not proven' when the evidence does not prove either.",
    "Every factual claim about code behavior must be grounded in one of the provided refs.",
    "If a concept or project identity is not proven by the current workspace evidence, say you cannot confirm it instead of guessing.",
    "Use only provided orchcode-file links. Do not invent file paths, line numbers, tools, or run commands.",
    "If evidence conflicts with the user's project name or idea, explain the conflict instead of forcing a label.",
    "Return strict JSON only. Do not wrap it in markdown."
  ].join("\n");
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
  const addSection = (section: ProjectExplainSection) => {
    const ref = normalizeRef(section.filePath, section.lineStart);
    if (byRef.has(ref)) return;
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
    if (byRef.has(ref)) return;
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
      errors.push(`answerMarkdown contains an unknown orchcode-file ref: ${ref}`);
    }
  }
  if (evidenceItems.length && linkedRefs.length === 0) {
    errors.push("answerMarkdown must include at least one provided orchcode-file link.");
  }
  const citedRefs = uniqueStrings([
    ...linkedRefs,
    ...(Array.isArray(response.usedEvidenceRefs) ? response.usedEvidenceRefs.map((ref) => typeof ref === "string" ? normalizeRefString(ref) : "") : [])
  ]);
  if (grounding.concept.specific) {
    if (!grounding.conceptFound) {
      errors.push(`requested concept was not found in the current workspace evidence: ${grounding.concept.label}`);
    } else if (!citedRefs.some((ref) => conceptSupportingRefs.has(ref))) {
      errors.push(`answer must cite evidence that directly supports the requested concept: ${grounding.concept.label}`);
    }
    if (grounding.concept.evidenceGroups?.length) {
      const citedItems = citedRefs
        .map((ref) => evidenceItems.find((candidate) => candidate.ref === ref))
        .filter((item): item is EvidenceItem => Boolean(item));
      const citedCoverage = createConceptEvidenceGroupCoverage(grounding.concept, citedItems);
      const missingGroups = citedCoverage.filter((group) => !group.found).map((group) => group.label);
      if (missingGroups.length) {
        errors.push(`answer citations must cover requested evidence group(s): ${missingGroups.join(", ")}`);
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
    grounding
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
  for (const match of markdown.matchAll(/orchcode-file:([^)\s]+):(\d+)/g)) {
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
  return `[${filePath}:${line}](orchcode-file:${encodeURIComponent(filePath)}:${line})`;
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

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}
