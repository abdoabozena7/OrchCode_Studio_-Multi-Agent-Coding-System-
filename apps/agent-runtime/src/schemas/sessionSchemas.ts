export const createSessionSchema = {
  type: "object",
  required: ["workspacePath", "mode", "userPrompt"],
  properties: {
    workspacePath: { type: "string", minLength: 1 },
    mode: { type: "string", enum: ["mock", "real"] },
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
