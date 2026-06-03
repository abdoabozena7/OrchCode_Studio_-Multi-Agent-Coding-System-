import type { AgenticEvidenceGraph, AgenticMentalModel, AgenticOutputDraft, AgenticTaskIntent } from "./AgenticTaskModels.js";
import { extractAgenticClaims } from "./AgenticClaimValidator.js";

export function synthesizeAgenticOutput(input: {
  prompt: string;
  intent: AgenticTaskIntent;
  evidenceGraph: AgenticEvidenceGraph;
  mentalModel: AgenticMentalModel;
  providerDraft?: string;
  providerFallbackReason?: AgenticOutputDraft["fallbackReason"];
}): AgenticOutputDraft {
  const text = input.providerDraft?.trim()
    ? input.providerDraft.trim()
    : input.intent.language === "arabic"
      ? synthesizeArabic(input.intent, input.evidenceGraph, input.mentalModel)
      : synthesizeEnglish(input.intent, input.evidenceGraph, input.mentalModel);
  return {
    format: "markdown",
    text,
    claims: extractAgenticClaims(text),
    fallbackReason: input.providerFallbackReason ?? "none"
  };
}

function synthesizeEnglish(intent: AgenticTaskIntent, graph: AgenticEvidenceGraph, model: AgenticMentalModel) {
  if (!graph.accepted.length) {
    return [
      "## What I Can Confirm",
      "I do not have enough accepted production evidence to answer this confidently.",
      "",
      "## Evidence Limits",
      model.rejectedOrDowngradedEvidence.length
        ? `The strongest candidates were downgraded or rejected: ${model.rejectedOrDowngradedEvidence.slice(0, 3).join("; ")}.`
        : "The adaptive read plan did not find relevant implementation evidence.",
      "",
      "## Unknowns",
      "I would treat the requested behavior as unknown until production source evidence is found."
    ].join("\n");
  }
  if (intent.mode === "design_assessment") return designAssessmentEnglish(graph, model);
  if (intent.mode === "debugging_analysis") return debuggingEnglish(graph, model);
  if (intent.mode === "refactor_planning" || intent.mode === "coding_planning" || intent.mode === "patch_preparation") return planningEnglish(intent, graph, model);
  if (intent.mode === "validation_planning" || intent.mode === "repair_planning") return validationOrRepairEnglish(intent, graph, model);
  if (intent.mode === "data_flow" || intent.mode === "ui_flow" || intent.mode === "backend_flow") return flowEnglish(intent, graph, model);
  return [
    "## Answer",
    summarySentence(intent, graph, model),
    "",
    "## Components",
    ...model.responsibilities.slice(0, 6).map((item) => `- ${item.component}: ${item.summary} ${citeEvidence(graph, item.evidenceIds)}`),
    "",
    "## Relationships",
    ...(model.dataOrControlFlow.length ? model.dataOrControlFlow.slice(0, 8).map((step) => `- ${step}`) : ["- No strong relationship chain was proven from opened files."]),
    "",
    "## Confidence",
    `Confidence is ${model.confidence}. ${model.unknowns.join(" ") || "Claims above are limited to opened workspace evidence."}`
  ].join("\n");
}

function synthesizeArabic(intent: AgenticTaskIntent, graph: AgenticEvidenceGraph, model: AgenticMentalModel) {
  if (!graph.accepted.length) {
    return [
      "## \u0627\u0644\u062e\u0644\u0627\u0635\u0629",
      "\u0645\u0634 \u0644\u0627\u0642\u064a \u062f\u0644\u064a\u0644 production \u0643\u0627\u0641\u064a \u064a\u0623\u0643\u062f \u0627\u0644\u0646\u0642\u0637\u0629 \u062f\u064a.",
      "",
      "## \u062d\u062f\u0648\u062f \u0627\u0644\u0623\u062f\u0644\u0629",
      model.rejectedOrDowngradedEvidence.length
        ? `\u0641\u064a\u0647 \u0623\u062f\u0644\u0629 \u0627\u062a\u0631\u0641\u0636\u062a \u0623\u0648 \u0627\u062a\u062e\u0641\u0636\u062a \u062b\u0642\u062a\u0647\u0627: ${model.rejectedOrDowngradedEvidence.slice(0, 3).join("; ")}.`
        : "\u062e\u0637\u0629 \u0627\u0644\u0642\u0631\u0627\u0621\u0629 \u0645\u0627\u0644\u0642\u062a\u0634 \u0643\u0648\u062f implementation \u0645\u0646\u0627\u0633\u0628.",
      "",
      "## \u0627\u0644\u0646\u062a\u064a\u062c\u0629",
      "\u0647\u0623\u0642\u0648\u0644 \u0625\u0646 \u0627\u0644\u0625\u062c\u0627\u0628\u0629 unknown \u0644\u062d\u062f \u0645\u0627 \u064a\u0638\u0647\u0631 \u062f\u0644\u064a\u0644 \u0645\u0646 \u0643\u0648\u062f production."
    ].join("\n");
  }
  return [
    "## \u0627\u0644\u062e\u0644\u0627\u0635\u0629",
    arabicSummarySentence(intent, graph, model),
    "",
    "## \u0627\u0644\u0645\u0643\u0648\u0646\u0627\u062a",
    ...model.responsibilities.slice(0, 6).map((item) => `- ${item.component}: ${item.summary} ${citeEvidence(graph, item.evidenceIds)}`),
    "",
    "## \u0627\u0644\u0639\u0644\u0627\u0642\u0627\u062a \u0648\u0627\u0644\u0641\u0644\u0648",
    ...(model.dataOrControlFlow.length ? model.dataOrControlFlow.slice(0, 8).map((step) => `- ${step}`) : ["- \u0645\u0641\u064a\u0634 relationship chain \u0642\u0648\u064a \u0627\u062a\u062b\u0628\u062a \u0645\u0646 \u0627\u0644\u0645\u0644\u0641\u0627\u062a \u0627\u0644\u0645\u0641\u062a\u0648\u062d\u0629."]),
    "",
    "## \u062d\u062f\u0648\u062f \u0627\u0644\u062b\u0642\u0629",
    `\u0627\u0644\u062b\u0642\u0629 ${model.confidence}. ${model.unknowns.join(" ") || "\u0627\u0644\u0643\u0644\u0627\u0645 \u0647\u0646\u0627 \u0645\u062d\u062f\u0648\u062f \u0628\u0627\u0644\u0623\u062f\u0644\u0629 \u0627\u0644\u0644\u064a \u0627\u062a\u0641\u062a\u062d\u062a \u0645\u0646 \u0627\u0644\u0648\u0631\u0643\u0633\u0628\u064a\u0633."}`
  ].join("\n");
}

function flowEnglish(intent: AgenticTaskIntent, graph: AgenticEvidenceGraph, model: AgenticMentalModel) {
  return [
    "## Flow",
    `${intent.mode} is supported by the opened files below.`,
    "",
    ...model.dataOrControlFlow.slice(0, 10).map((step, index) => `${index + 1}. ${step}`),
    "",
    "## Evidence",
    ...graph.accepted.slice(0, 8).map((item) => `- ${formatEvidence(item)}`),
    "",
    "## Limits",
    model.unknowns.join(" ") || "This flow only covers relationships visible within the read budget."
  ].join("\n");
}

function designAssessmentEnglish(graph: AgenticEvidenceGraph, model: AgenticMentalModel) {
  return [
    "## Facts",
    ...graph.accepted.slice(0, 6).map((item) => `- ${formatEvidence(item)}`),
    "",
    "## Assessment",
    `Opinion: the design looks ${model.confidence === "high" ? "traceable" : "partially traceable"} from the opened evidence, but conclusions should stay within the cited components.`,
    "",
    "## Risks",
    ...(model.risks.length ? model.risks.map((risk) => `- ${risk}`) : ["- No additional design risk was proven from the opened files."])
  ].join("\n");
}

function debuggingEnglish(graph: AgenticEvidenceGraph, model: AgenticMentalModel) {
  return [
    "## Debugging Hypothesis",
    "The strongest local clues are the evidence items below; treat this as a hypothesis until validation is run.",
    "",
    ...graph.accepted.slice(0, 8).map((item) => `- ${formatEvidence(item)}`),
    "",
    "## Next Checks",
    "- Reproduce the failure with the narrowest command that covers the cited module.",
    "- Inspect any validation output that names the same paths or symbols.",
    "- Avoid changing unrelated files until the cited path is confirmed as the failure source."
  ].join("\n");
}

function planningEnglish(intent: AgenticTaskIntent, graph: AgenticEvidenceGraph, model: AgenticMentalModel) {
  return [
    "## Planning Context",
    `${intent.mode} should start from these production files: ${model.importantFiles.slice(0, 8).join(", ") || "none found"}.`,
    "",
    "## Boundaries",
    "- Keep changes scoped to the cited components.",
    "- Preserve existing approval, patch, validation, and integration gates.",
    "",
    "## Evidence",
    ...graph.accepted.slice(0, 8).map((item) => `- ${formatEvidence(item)}`)
  ].join("\n");
}

function validationOrRepairEnglish(intent: AgenticTaskIntent, graph: AgenticEvidenceGraph, model: AgenticMentalModel) {
  return [
    "## Strategy",
    `${intent.mode} should validate the cited components first, then broaden only if the result points elsewhere.`,
    "",
    "## Candidate Checks",
    ...model.importantFiles.slice(0, 8).map((file) => `- Check behavior around ${file}.`),
    "",
    "## Evidence",
    ...graph.accepted.slice(0, 8).map((item) => `- ${formatEvidence(item)}`)
  ].join("\n");
}

function summarySentence(intent: AgenticTaskIntent, graph: AgenticEvidenceGraph, model: AgenticMentalModel) {
  const first = graph.accepted[0];
  const subject = intent.topic === "current project" ? "The requested topic" : `\`${intent.topic}\``;
  return `${subject} is grounded in ${model.importantFiles.slice(0, 3).join(", ") || first?.path}. The answer below is based on accepted workspace evidence, not fixture-only or generated artifacts.`;
}

function arabicSummarySentence(intent: AgenticTaskIntent, graph: AgenticEvidenceGraph, model: AgenticMentalModel) {
  const subject = intent.topic === "current project" ? "\u0627\u0644\u0646\u0642\u0637\u0629 \u0627\u0644\u0645\u0637\u0644\u0648\u0628\u0629" : `\`${intent.topic}\``;
  return `${subject} \u0645\u062a\u062f\u0639\u0645\u0629 \u0645\u0646 ${model.importantFiles.slice(0, 3).join(", ") || graph.accepted[0]?.path}. \u0627\u0644\u0634\u0631\u062d \u0645\u0628\u0646\u064a \u0639\u0644\u0649 \u0623\u062f\u0644\u0629 workspace \u0645\u0642\u0628\u0648\u0644\u0629\u060c \u0645\u0634 fixtures \u0623\u0648 generated artifacts.`;
}

function citeEvidence(graph: AgenticEvidenceGraph, ids: string[]) {
  const item = graph.items.find((candidate) => ids.includes(candidate.id));
  if (!item) return "";
  return `[${item.path}:${item.lineStart ?? 1}](hivo-file:${encodeURIComponent(item.path)}:${item.lineStart ?? 1})`;
}

function formatEvidence(item: { path: string; lineStart?: number; snippet: string }) {
  return `[${item.path}:${item.lineStart ?? 1}](hivo-file:${encodeURIComponent(item.path)}:${item.lineStart ?? 1}) - ${oneLine(item.snippet).slice(0, 180)}`;
}

function oneLine(text: string) {
  return text.replace(/\s+/g, " ").trim();
}
