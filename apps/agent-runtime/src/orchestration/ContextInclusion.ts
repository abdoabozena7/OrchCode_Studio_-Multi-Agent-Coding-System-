import type {
  ContextFreshness,
  ContextPack,
  ContextPackInclusionRecord,
  ContextRetrievalSummary
} from "./OrchestrationModels.js";

export function getContextPackIncludedItems(pack: ContextPack): ContextPackInclusionRecord[] {
  return pack.included_items ?? [];
}

export function summarizeContextInclusions(pack: ContextPack): ContextRetrievalSummary {
  return pack.retrieval_summary ?? summarizeRecords(pack.included_items ?? [], pack.excluded_items ?? []);
}

export function findLowConfidenceContextItems(pack: ContextPack): ContextPackInclusionRecord[] {
  return (pack.included_items ?? []).filter((item) => item.confidence === "low");
}

export function findStaleContextItems(pack: ContextPack): ContextPackInclusionRecord[] {
  return (pack.included_items ?? []).filter((item) => isStaleOrUnknown(item.freshness));
}

export function summarizeRecords(
  includedItems: ContextPackInclusionRecord[],
  excludedItems: ContextPackInclusionRecord[] = []
): ContextRetrievalSummary {
  return {
    total_included_items: includedItems.length,
    editable_file_count: includedItems.filter((item) => item.access_mode === "editable").length,
    read_only_file_count: includedItems.filter((item) => item.access_mode === "read_only").length,
    forbidden_reference_count: includedItems.filter((item) => item.access_mode === "forbidden" || item.source_type === "forbidden_file_reference").length,
    memory_item_count: includedItems.filter((item) => item.access_mode === "memory_only").length,
    decision_count: includedItems.filter((item) => item.source_type === "prior_decision").length,
    prior_failure_count: includedItems.filter((item) => item.source_type === "prior_failure").length,
    validation_command_count: includedItems.filter((item) => item.source_type === "validation_command").length,
    stale_or_unknown_count: includedItems.filter((item) => isStaleOrUnknown(item.freshness)).length,
    low_confidence_count: includedItems.filter((item) => item.confidence === "low").length,
    fallback_item_count: includedItems.filter((item) => item.source_type === "fallback_heuristic").length,
    warning_count: includedItems.reduce((sum, item) => sum + item.warnings.length, 0) + excludedItems.length
  };
}

function isStaleOrUnknown(freshness: ContextFreshness) {
  return freshness === "stale" || freshness === "unknown" || freshness === "possibly_stale";
}
