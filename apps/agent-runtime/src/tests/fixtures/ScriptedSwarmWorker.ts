import { SWARM_SCHEMA_VERSION, type SwarmWorker } from "../../orchestration/index.js";

export const scriptedSwarmWorker: SwarmWorker = async (input) => {
  const invalid = input.workItem.expected_output_schema === "InvalidOutput";
  const validationFailure = input.workItem.type === "test"
    && input.workItem.read_files.some((command) => /exit\(3\)|fail/i.test(command));
  return {
    schema_version: SWARM_SCHEMA_VERSION,
    work_item_id: input.workItem.id,
    status: invalid || validationFailure ? "failed" : "succeeded",
    summary: `${input.agent.role} completed ${input.workItem.type} scripted test work.`,
    relevant_files: input.workItem.read_files.filter((file) => !looksLikeCommand(file)),
    findings: [`${input.workItem.type} test work used schema ${input.workItem.expected_output_schema}.`],
    risks: input.workItem.risk_level === "low" ? [] : [`${input.workItem.risk_level} risk work requires review evidence.`],
    unknowns: [],
    validation_passed: input.workItem.type === "test" ? !validationFailure : undefined,
    structured_output_valid: !invalid,
    confidence: input.workItem.risk_level === "critical" ? 0.62 : input.workItem.risk_level === "high" ? 0.72 : 0.86
  };
};

function looksLikeCommand(value: string) {
  return /^(npm|pnpm|yarn|cargo|python|pytest|go|dotnet|mvn|gradle|make)\b/i.test(value.trim());
}
