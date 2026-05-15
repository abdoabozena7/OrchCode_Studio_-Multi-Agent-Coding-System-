import type {
  ModuleExecutionPlan,
  ProjectContextPack,
  ProjectIntake,
  RunToGreenAttempt,
  RunToGreenDiagnosis,
  RunToGreenSelectedCommand,
  RunToGreenState
} from "@orchcode/protocol";
import type { LaunchRecommendation } from "./ProjectLaunchInference.js";

type CommandSelectionInput = {
  sessionId: string;
  workspacePath: string;
  message: string;
  modulePlan?: ModuleExecutionPlan;
  intake?: ProjectIntake;
  contextPack?: ProjectContextPack;
  launchRecommendation?: LaunchRecommendation | null;
  now: string;
};

type DiagnoseInput = {
  command: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  modulePlan?: ModuleExecutionPlan;
  hasAlternativeCommand: boolean;
};

export const DEFAULT_RUN_TO_GREEN_MAX_ATTEMPTS = 3;

export function initializeRunToGreenState(input: CommandSelectionInput): RunToGreenState {
  const selectedCommands = selectRunToGreenCommands(input);
  const first = selectedCommands[0];
  const staticWorkspaceWithoutCommand =
    !first &&
    Boolean(input.launchRecommendation) &&
    !input.intake?.knownCommands.length &&
    !input.contextPack?.verificationCommands.length &&
    !input.modulePlan?.verificationCommands.length;
  return {
    id: `run_to_green_${Date.now()}`,
    sessionId: input.sessionId,
    status: first ? "running" : "blocked",
    intent: "run_to_green",
    objective: input.message,
    selectedCommands,
    currentAttempt: first ? 1 : 0,
    maxAttempts: DEFAULT_RUN_TO_GREEN_MAX_ATTEMPTS,
    attempts: first
      ? [{
          attemptNumber: 1,
          command: first.command,
          cwd: first.cwd,
          startedAt: input.now,
          status: "running",
          changedFiles: []
        }]
      : [],
    finalStatus: first ? "unknown" : "blocked",
    blockerReason: first
      ? undefined
      : staticWorkspaceWithoutCommand
        ? "No grounded run command was found for this static workspace. Open index.html manually or configure a run script."
        : "No safe run/build/test command could be selected from the project intake, context pack, or detected scripts.",
    createdAt: input.now,
    updatedAt: input.now
  };
}

export function selectRunToGreenCommands(input: CommandSelectionInput): RunToGreenSelectedCommand[] {
  const commands: RunToGreenSelectedCommand[] = [];
  const knownCommands = [
    ...(input.modulePlan?.verificationCommands ?? []),
    ...(input.intake?.knownCommands ?? []),
    ...(input.contextPack?.verificationCommands ?? [])
  ];
  const explicit = inferExplicitCommand(input.message, knownCommands, input.launchRecommendation?.command);
  const shouldPreferLaunch =
    !explicit &&
    /\b(run|start|launch|open)\b.+\b(project|app|site|game)\b/i.test(input.message) &&
    input.launchRecommendation?.strategy === "package_script" &&
    Boolean(input.launchRecommendation.command);
  if (explicit) {
    commands.push({
      command: explicit,
      cwd: input.workspacePath,
      source: "explicit_user_command",
      reason: "User explicitly requested this command."
    });
  }
  if (shouldPreferLaunch && input.launchRecommendation?.command) {
    commands.push({
      command: input.launchRecommendation.command,
      cwd: input.workspacePath,
      source: "launch_inference",
      reason: input.launchRecommendation.reason
    });
  }
  for (const command of input.modulePlan?.verificationCommands ?? []) {
    commands.push({
      command,
      cwd: input.workspacePath,
      source: "module_verification_command",
      reason: "Selected from the scoped module verification commands."
    });
  }
  for (const command of input.intake?.knownCommands ?? []) {
    commands.push({
      command,
      cwd: input.workspacePath,
      source: "project_intake_command",
      reason: "Selected from commands discovered during project intake."
    });
  }
  for (const command of input.contextPack?.verificationCommands ?? []) {
    commands.push({
      command,
      cwd: input.workspacePath,
      source: "context_pack_command",
      reason: "Selected from context-pack verification commands."
    });
  }
  if (!shouldPreferLaunch && input.launchRecommendation?.command) {
    const hasGroundedProjectCommand =
      Boolean(input.modulePlan?.verificationCommands.length) ||
      Boolean(input.intake?.knownCommands.length) ||
      Boolean(input.contextPack?.verificationCommands.length);
    if (hasGroundedProjectCommand || input.launchRecommendation.strategy === "package_script") {
      commands.push({
        command: input.launchRecommendation.command,
        cwd: input.workspacePath,
        source: "launch_inference",
        reason: input.launchRecommendation.reason
      });
    }
  }
  return dedupeCommands(commands);
}

export function diagnoseRunToGreenFailure(input: DiagnoseInput): RunToGreenDiagnosis {
  const combined = `${input.stdout ?? ""}\n${input.stderr ?? ""}`.trim();
  const normalized = combined.toLowerCase();
  const filePath = extractFilePath(combined);
  const evidence = {
    command: input.command,
    exitCode: input.exitCode,
    stdoutSummary: summarizeOutput(input.stdout),
    stderrSummary: summarizeOutput(input.stderr),
    filePath
  };

  if (/missing script[:\s]/i.test(combined)) {
    return {
      category: "script_missing",
      confidence: "high",
      evidence,
      safeFixAvailable: input.hasAlternativeCommand,
      requiresApproval: false,
      reason: input.hasAlternativeCommand
        ? "The selected package script is missing, but an alternate project command is available."
        : "The selected package script is missing and no safe alternate command was discovered."
    };
  }
  if (/\b(command not found|is not recognized as an internal or external command|not recognized as an internal or external command)\b/i.test(combined)) {
    return {
      category: "command_not_found",
      confidence: "high",
      evidence,
      safeFixAvailable: input.hasAlternativeCommand,
      requiresApproval: false,
      reason: input.hasAlternativeCommand
        ? "The selected command is unavailable in this environment, but an alternate command exists."
        : "The selected command is unavailable in this environment."
    };
  }
  if (/\b(eacces|eperm|permission denied)\b/i.test(combined)) {
    return {
      category: "permission_error",
      confidence: "high",
      evidence,
      safeFixAvailable: false,
      requiresApproval: true,
      reason: "The failure looks like a permission problem outside normal scoped code edits."
    };
  }
  if (/\b(eaddrinuse|address already in use|port \d+.*in use)\b/i.test(combined)) {
    return {
      category: "port_in_use",
      confidence: "high",
      evidence,
      safeFixAvailable: false,
      requiresApproval: false,
      reason: "The selected command failed because the target port is already in use."
    };
  }
  if (/\b(env|environment variable|missing env|dotenv)\b/i.test(normalized) && /\b(missing|required|not set|undefined)\b/i.test(normalized)) {
    return {
      category: "environment_error",
      confidence: "medium",
      evidence,
      safeFixAvailable: false,
      requiresApproval: true,
      reason: "The failure appears to depend on missing environment configuration rather than a safe local code edit."
    };
  }
  if (/\b(ts\d{3,5}|type .+ is not assignable|typescript)\b/i.test(combined)) {
    return {
      category: "type_error",
      confidence: filePath ? "high" : "medium",
      evidence,
      safeFixAvailable: Boolean(input.modulePlan),
      requiresApproval: true,
      reason: filePath
        ? `Type-checking failed near ${filePath}.`
        : "Type-checking failed, but the exact file could not be proven."
    };
  }
  if (/\beslint|lint\b/i.test(normalized) && /\b(error|failed)\b/i.test(normalized)) {
    return {
      category: "lint_error",
      confidence: "medium",
      evidence,
      safeFixAvailable: false,
      requiresApproval: true,
      reason: "The selected command failed linting, but automatic lint fixes are not assumed safe by default."
    };
  }
  if (/\b(assertionerror|expected .+ to|failing tests|test failed|vitest failed|jest failed)\b/i.test(combined)) {
    return {
      category: "test_failure",
      confidence: filePath ? "medium" : "low",
      evidence,
      safeFixAvailable: false,
      requiresApproval: true,
      reason: "Tests failed, but changing behavior or expectations automatically would be too risky without stronger evidence."
    };
  }
  if (/\b(cannot find module|module not found|failed to resolve import|cannot resolve module|missing export)\b/i.test(combined)) {
    return {
      category: "import_error",
      confidence: filePath ? "high" : "medium",
      evidence,
      safeFixAvailable: Boolean(input.modulePlan),
      requiresApproval: true,
      reason: filePath
        ? `An import or export problem appears near ${filePath}.`
        : "An import or export problem was detected, but the exact file could not be proven."
    };
  }
  if (/\b(cannot find package|missing dependency|npm err! code enoent|pnpm: command not found)\b/i.test(combined)) {
    return {
      category: "dependency_missing",
      confidence: "medium",
      evidence,
      safeFixAvailable: false,
      requiresApproval: true,
      reason: "The failure looks dependency-related, and automatic installs or dependency changes are out of scope by default."
    };
  }
  if (/\b(config|tsconfig|vite\.config|tauri\.conf|json parse|invalid configuration)\b/i.test(normalized) && /\b(error|failed|invalid|cannot)\b/i.test(normalized)) {
    return {
      category: "config_error",
      confidence: filePath ? "high" : "medium",
      evidence,
      safeFixAvailable: Boolean(input.modulePlan),
      requiresApproval: true,
      reason: filePath
        ? `A configuration problem appears near ${filePath}.`
        : "A configuration problem was detected, but the exact file could not be proven."
    };
  }
  if (/\b(build failed|compilation failed|compile error|transform failed)\b/i.test(normalized)) {
    return {
      category: "build_error",
      confidence: filePath ? "medium" : "low",
      evidence,
      safeFixAvailable: Boolean(input.modulePlan) && Boolean(filePath),
      requiresApproval: true,
      reason: filePath
        ? `Build failure appears near ${filePath}.`
        : "Build failed, but the exact repair target could not be proven."
    };
  }
  if (/\b(referenceerror|typeerror|syntaxerror|unhandled)\b/i.test(combined)) {
    return {
      category: "runtime_exception",
      confidence: filePath ? "medium" : "low",
      evidence,
      safeFixAvailable: Boolean(input.modulePlan) && Boolean(filePath),
      requiresApproval: true,
      reason: filePath
        ? `Runtime exception appears near ${filePath}.`
        : "Runtime exception detected, but the exact repair target is still uncertain."
    };
  }

  return {
    category: "unknown",
    confidence: "low",
    evidence,
    safeFixAvailable: false,
    requiresApproval: true,
    reason: "The failure could not be diagnosed confidently enough for an automatic scoped repair."
  };
}

export function findAlternateRunToGreenCommand(state: RunToGreenState): RunToGreenSelectedCommand | undefined {
  const attempted = new Set(state.attempts.map((attempt) => attempt.command));
  return state.selectedCommands.find((command) => !attempted.has(command.command));
}

export function markNextRunToGreenAttempt(
  state: RunToGreenState,
  command: RunToGreenSelectedCommand,
  reason: string,
  now: string
) {
  state.currentAttempt += 1;
  state.pendingRepairPatchId = undefined;
  state.pendingRerunCommand = undefined;
  state.pendingRerunReason = undefined;
  state.updatedAt = now;
  state.attempts.push({
    attemptNumber: state.currentAttempt,
    command: command.command,
    cwd: command.cwd,
    startedAt: now,
    status: "running",
    changedFiles: [],
    rerunReason: reason
  });
}

export function getCurrentRunToGreenAttempt(state: RunToGreenState): RunToGreenAttempt | undefined {
  return state.attempts.find((attempt) => attempt.attemptNumber === state.currentAttempt);
}

export function createDiagnosisFingerprint(diagnosis: RunToGreenDiagnosis | undefined) {
  if (!diagnosis) return "";
  return [
    diagnosis.category,
    diagnosis.evidence.filePath ?? "",
    diagnosis.reason
  ].join("|");
}

function inferExplicitCommand(message: string, knownCommands: string[], launchCommand?: string) {
  const normalized = message.toLowerCase();
  for (const command of [launchCommand, ...knownCommands].filter((value): value is string => Boolean(value))) {
    if (normalized.includes(command.toLowerCase())) {
      return command;
    }
  }
  const backtickMatch = message.match(/`([^`]+)`/);
  if (backtickMatch?.[1]) {
    return backtickMatch[1].trim();
  }
  const directMatch = message.match(/\b(run|start|launch|execute)\s+((?:npm|pnpm|yarn|cargo|python|node)\b[^\n\r]*)/i);
  return directMatch?.[2]?.trim();
}

function dedupeCommands(commands: RunToGreenSelectedCommand[]) {
  const seen = new Set<string>();
  const output: RunToGreenSelectedCommand[] = [];
  for (const command of commands) {
    const key = `${command.cwd}::${command.command}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(command);
  }
  return output;
}

function summarizeOutput(text: string | undefined, limit = 240) {
  if (!text) return undefined;
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) return undefined;
  return compact.length > limit ? `${compact.slice(0, limit - 3)}...` : compact;
}

function extractFilePath(text: string) {
  const match = text.match(/([A-Za-z0-9_./-]+\.(?:ts|tsx|js|jsx|json|mjs|cjs|rs|py|html|css))/);
  return match?.[1];
}
