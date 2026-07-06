import { extractAgenticClaims } from "./AgenticClaimValidator.js";
import type { AgenticOutputDraft } from "./AgenticTaskModels.js";

export function synthesizeAgenticOutput(input: {
  providerDraft?: string;
  providerFallbackReason?: AgenticOutputDraft["fallbackReason"];
}): AgenticOutputDraft {
  const providerText = input.providerDraft?.trim();
  if (!providerText) {
    return {
      format: "markdown",
      text: "",
      claims: [],
      fallbackReason: input.providerFallbackReason && input.providerFallbackReason !== "none"
        ? input.providerFallbackReason
        : "adapter_not_available"
    };
  }
  return {
    format: "markdown",
    text: providerText,
    claims: extractAgenticClaims(providerText),
    fallbackReason: input.providerFallbackReason ?? "none"
  };
}
