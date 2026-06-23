export const createSessionSchema = {
  type: "object",
  required: ["workspacePath", "userPrompt"],
  properties: {
    workspacePath: { type: "string", minLength: 1 },
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
  name: "run-patch-intent",
  type: "object",
  additionalProperties: false,
  required: ["title", "summary", "intents"],
  properties: {
    title: { type: "string" },
    summary: { type: "string" },
    intents: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "operation", "replacementText", "reason", "risk"],
        properties: {
          path: { type: "string" },
          operation: {
            type: "string",
            enum: ["create_file", "overwrite_file", "replace_range", "insert_after", "insert_before", "delete_range"]
          },
          anchorText: { type: "string" },
          preimageText: { type: "string" },
          replacementText: { type: "string" },
          reason: { type: "string" },
          risk: { type: "string", enum: ["low", "medium", "high"] }
        }
      }
    },
    suggestedCommands: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["command", "reason"],
        properties: {
          command: { type: "string" },
          reason: { type: "string" }
        }
      }
    }
  }
} as const;

export const runVerificationSchema = {
  name: "run-verification"
} as const;

export const projectExplainSchema = {
  name: "project-explain"
} as const;

export const conversationIntentDecisionSchema = {
  name: "conversation-intent-decision"
} as const;

const stringArraySchema = { type: "array", items: { type: "string" } } as const;
const providerClaimSchema = {
  type: "object",
  required: ["id", "text", "material", "evidenceIds", "confidence"],
  properties: {
    id: { type: "string" },
    text: { type: "string" },
    material: { type: "boolean" },
    evidenceIds: stringArraySchema,
    confidence: { type: "string", enum: ["high", "medium", "low"] }
  },
  additionalProperties: false
} as const;
const providerAuthoredResultJsonSchema = {
  type: "object",
  required: ["decision", "answerMarkdown", "claims", "evidenceRefs", "unknowns", "rationale"],
  properties: {
    decision: { type: "string", enum: ["ANSWER", "FOLLOW_UP", "REFUSE", "ESCALATE"] },
    answerMarkdown: { type: "string" },
    claims: { type: "array", items: { oneOf: [{ type: "string" }, providerClaimSchema] } },
    evidenceRefs: stringArraySchema,
    unknowns: stringArraySchema,
    rationale: { type: "string" }
  },
  additionalProperties: false
} as const;
const reasoningToolRequestJsonSchema = {
  type: "object",
  required: ["id", "kind", "reason"],
  properties: {
    id: { type: "string" },
    kind: {
      type: "string",
      enum: ["list_files", "repository_search", "read_file", "inspect_manifest", "investigate_project", "semantic_search", "follow_relationships", "read_semantic_sources", "run_command", "propose_patch", "analyze_project", "delegate_readonly"]
    },
    reason: { type: "string" },
    query: { type: "string" },
    path: { type: "string" },
    paths: stringArraySchema,
    command: { type: "string" },
    limit: { type: "integer", minimum: 1 },
    relatedNodeIds: stringArraySchema,
    patch: {
      type: "object",
      required: ["title", "summary", "filesChanged", "unifiedDiff", "riskLevel", "rollbackPlan"],
      properties: {
        title: { type: "string" },
        summary: { type: "string" },
        filesChanged: {
          type: "array",
          items: {
            type: "object",
            required: ["path", "changeType", "summary"],
            properties: {
              path: { type: "string" },
              changeType: { type: "string", enum: ["create", "modify", "delete"] },
              summary: { type: "string" }
            },
            additionalProperties: false
          }
        },
        unifiedDiff: { type: "string" },
        riskLevel: { type: "string", enum: ["low", "medium", "high"] },
        rollbackPlan: { type: "string" }
      },
      additionalProperties: false
    }
  },
  allOf: [
    {
      if: { properties: { kind: { enum: ["repository_search", "investigate_project", "semantic_search", "delegate_readonly"] } }, required: ["kind"] },
      then: { required: ["query"] }
    },
    {
      if: { properties: { kind: { const: "read_file" } }, required: ["kind"] },
      then: { anyOf: [{ required: ["path"] }, { required: ["paths"] }] }
    },
    {
      if: { properties: { kind: { enum: ["follow_relationships", "read_semantic_sources"] } }, required: ["kind"] },
      then: { required: ["relatedNodeIds"] }
    },
    {
      if: { properties: { kind: { const: "run_command" } }, required: ["kind"] },
      then: { required: ["command"] }
    },
    {
      if: { properties: { kind: { const: "propose_patch" } }, required: ["kind"] },
      then: { required: ["patch"] }
    }
  ],
  additionalProperties: false
} as const;
const turnUnderstandingJsonSchema = {
  type: "object",
  required: ["originalRequest", "cleanedRequest", "language", "intentKind", "route", "needsWorkspace", "goal", "ambiguities", "requiredEvidence", "risk", "confidence", "rationale"],
  properties: {
    originalRequest: { type: "string" },
    cleanedRequest: { type: "string" },
    language: { type: "string", enum: ["arabic", "english"] },
    intentKind: { type: "string", enum: ["direct_conversation", "workspace_question", "workspace_action", "run_request"] },
    route: { type: "string", enum: ["chat", "inspect_explain", "simple_run", "orchestrated_run", "recursive_factory", "swarm_readonly"] },
    needsWorkspace: { type: "boolean" },
    goal: { type: "string" },
    ambiguities: stringArraySchema,
    requiredEvidence: stringArraySchema,
    risk: { type: "string", enum: ["low", "medium", "high"] },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    rationale: { type: "string" }
  },
  additionalProperties: false
} as const;
const reasoningStepJsonSchema = {
  type: "object",
  required: ["id", "kind", "rationale", "toolRequests", "missingFacts", "successCriteria"],
  properties: {
    id: { type: "string" },
    kind: { type: "string", enum: ["tool_batch", "final", "ask_user", "refuse", "escalate"] },
    rationale: { type: "string" },
    toolRequests: { type: "array", items: reasoningToolRequestJsonSchema },
    result: providerAuthoredResultJsonSchema,
    missingFacts: stringArraySchema,
    successCriteria: stringArraySchema,
    expectedInformationGain: { type: "string" },
    targetUnknowns: stringArraySchema,
    stopCondition: { type: "string" }
  },
  additionalProperties: false
} as const;

export const turnUnderstandingSchema = {
  name: "turn-understanding",
  ...turnUnderstandingJsonSchema
} as const;

export const reasoningStepSchema = {
  name: "reasoning-step",
  ...reasoningStepJsonSchema
} as const;

export const initialReasoningDecisionSchema = {
  name: "initial-reasoning-decision",
  type: "object",
  required: ["understanding", "step"],
  properties: {
    understanding: turnUnderstandingJsonSchema,
    step: reasoningStepJsonSchema
  },
  additionalProperties: false
} as const;

export const providerAuthoredResultSchema = {
  name: "provider-authored-result",
  ...providerAuthoredResultJsonSchema
} as const;

export const answerVerificationSchema = {
  name: "answer-verification",
  type: "object",
  required: ["verdict", "rationale", "supportedClaims", "unsupportedClaims", "missingFacts", "evidenceRefs"],
  properties: {
    verdict: { type: "string", enum: ["pass", "fail", "needs_more_evidence"] },
    rationale: { type: "string" },
    workspaceEvidenceRequired: { type: "boolean" },
    recommendedBudgetProfile: { type: "string", enum: ["conversation", "project", "deep_project", "action"] },
    supportedClaims: stringArraySchema,
    unsupportedClaims: stringArraySchema,
    missingFacts: stringArraySchema,
    evidenceRefs: stringArraySchema
  },
  additionalProperties: false
} as const;

export const evidenceCurationSchema = {
  name: "evidence-curation",
  type: "object",
  required: ["selectedEvidenceRefs", "missingFacts", "rationale"],
  properties: {
    selectedEvidenceRefs: stringArraySchema,
    missingFacts: stringArraySchema,
    rationale: { type: "string" }
  },
  additionalProperties: false
} as const;

export const adaptiveReasoningJudgeSchema = {
  name: "adaptive-reasoning-judge",
  type: "object",
  required: ["correct", "evidenceSupported", "safe", "correctRefusal", "unsupportedMaterialClaims", "safetyErrors", "rationale"],
  properties: {
    correct: { type: "boolean" },
    evidenceSupported: { type: "boolean" },
    safe: { type: "boolean" },
    correctRefusal: { type: "boolean" },
    unsupportedMaterialClaims: stringArraySchema,
    safetyErrors: stringArraySchema,
    rationale: { type: "string" }
  },
  additionalProperties: false
} as const;
