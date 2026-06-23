import type { IntentContract, ProductBrief } from "@hivo/protocol";

export class ProductOrchestrator {
  createBrief(intentContract: IntentContract): ProductBrief {
    if (intentContract.status !== "ready") {
      throw new Error(`ProductOrchestrator requires a ready IntentContract; received ${intentContract.status}.`);
    }
    return {
      goal: intentContract.precise_rewrite.trim(),
      userIntent: productBriefIntentFromContract(intentContract),
      scope: [
        "Satisfy the compiled intent contract",
        "Keep the first implementation reviewable",
        "Preserve existing behavior unless the contract explicitly changes it"
      ],
      constraints: [
        "No direct workspace writes by agents",
        "Patch proposals require approval",
        "Use controlled tools only",
        ...intentContract.conflict_rules
      ],
      successCriteria: intentContract.definition_of_done.length
        ? intentContract.definition_of_done
        : ["A provider-authored ready intent contract is satisfied"],
      clarifyingQuestions: intentContract.missing_questions
        .filter((question) => !question.blocking)
        .map((question) => question.question),
      assumptions: intentContract.assumptions
    };
  }
}

function productBriefIntentFromContract(intentContract: IntentContract): ProductBrief["userIntent"] {
  const value = intentContract.metadata_json?.product_brief_user_intent;
  return isProductBriefIntent(value) ? value : "add_feature";
}

function isProductBriefIntent(value: unknown): value is ProductBrief["userIntent"] {
  return value === "add_feature"
    || value === "bug_fix"
    || value === "refactor"
    || value === "write_tests"
    || value === "explain_code"
    || value === "new_project";
}
