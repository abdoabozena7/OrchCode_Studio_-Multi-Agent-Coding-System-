export const createSessionSchema = {
  type: "object",
  required: ["workspacePath", "mode", "userPrompt"],
  properties: {
    workspacePath: { type: "string", minLength: 1 },
    mode: { type: "string", enum: ["demo_mock", "real_provider"] },
    userPrompt: { type: "string", minLength: 1 }
  }
} as const;

export const turnSchema = {
  type: "object",
  required: ["message"],
  properties: {
    message: { type: "string", minLength: 1 }
  }
} as const;

export const agentPlanSchema = {
  name: "agent-plan"
} as const;

export const runPlanSchema = {
  name: "run-plan"
} as const;

export const runPatchSchema = {
  name: "run-patch"
} as const;

export const runPatchIntentSchema = {
  name: "run-patch-intent"
} as const;

export const runVerificationSchema = {
  name: "run-verification"
} as const;
