import fs from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type {
  AgentRuntimeSession,
  CommandExecutionRecord,
  CommandRequest,
  PatchProposal,
  ProjectMap,
  RecursiveDiscoveredValidationCommand,
  RecursiveValidationEvidence,
  RecursiveValidationStrategy,
  ValidationTruthStatus
} from "@hivo/protocol";
import { readMemorySnapshotSync } from "../memory/SqliteMemoryStore.js";
import type { CommandInventory } from "../memory/types.js";
import { classifyCommandRisk, looksLikeBackgroundCommand, looksLikeNetworkCommand } from "../tools/CommandPolicy.js";
import { resolveInsideWorkspace } from "../tools/security.js";

type DiscoveryInput = {
  workspacePath: string;
  projectMap?: ProjectMap;
};

const VALIDATION_KIND_ORDER = ["test", "typecheck", "lint", "smoke", "build", "unknown"] as const;

export function discoverRecursiveValidationCommands(input: DiscoveryInput): RecursiveDiscoveredValidationCommand[] {
  const commands: RecursiveDiscoveredValidationCommand[] = [];
  const add = (command: string, cwd: string, kind: RecursiveDiscoveredValidationCommand["kind"], source: string, reason: string, forceBlocked = false) => {
    const normalized = command.trim();
    if (!normalized) return;
    commands.push(classifyDiscoveredValidationCommand({
      command: normalized,
      cwd,
      kind,
      source,
      reason,
      workspacePath: input.workspacePath,
      forceBlocked
    }));
  };

  const packageFiles = findFiles(input.workspacePath, "package.json", 4);
  for (const file of packageFiles) {
    try {
      const relative = relativePath(input.workspacePath, file);
      const cwd = relativePath(input.workspacePath, path.dirname(file)) || ".";
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { scripts?: Record<string, string>; packageManager?: string };
      const packageManager = packageManagerForPackage(parsed.packageManager, input.workspacePath, file);
      for (const [scriptName, body] of Object.entries(parsed.scripts ?? {})) {
        const kind = classifyValidationKind(scriptName, body);
        if (!isValidationKind(kind)) continue;
        const unsafeBody = looksLikeInstallOrNetworkScript(body);
        add(
          packageRunCommand(packageManager, scriptName),
          cwd,
          kind,
          `package.json:${relative}:${scriptName}`,
          unsafeBody ? `package.json script "${scriptName}" contains install/network behavior.` : `package.json script "${scriptName}".`,
          unsafeBody
        );
      }
    } catch {
      // Ignore malformed package.json during discovery; it should not produce a false command.
    }
  }

  for (const file of findFiles(input.workspacePath, "requirements.txt", 4)) {
    const text = safeRead(file);
    const cwd = relativePath(input.workspacePath, path.dirname(file)) || ".";
    if (/pytest/i.test(text) || text.trim()) add("pytest", cwd, "test", `python:${relativePath(input.workspacePath, file)}`, "requirements.txt indicates a Python workspace.");
    if (/ruff/i.test(text)) add("ruff check .", cwd, "lint", `python:${relativePath(input.workspacePath, file)}`, "requirements.txt mentions ruff.");
    if (/mypy/i.test(text)) add("mypy .", cwd, "typecheck", `python:${relativePath(input.workspacePath, file)}`, "requirements.txt mentions mypy.");
  }

  for (const file of findFiles(input.workspacePath, "pyproject.toml", 4)) {
    const text = safeRead(file);
    const cwd = relativePath(input.workspacePath, path.dirname(file)) || ".";
    if (/pytest|tool\.pytest|unittest/i.test(text)) add("pytest", cwd, "test", `python:${relativePath(input.workspacePath, file)}`, "pyproject.toml contains pytest/unittest configuration.");
    if (/ruff/i.test(text)) add("ruff check .", cwd, "lint", `python:${relativePath(input.workspacePath, file)}`, "pyproject.toml mentions ruff.");
    if (/mypy/i.test(text)) add("mypy .", cwd, "typecheck", `python:${relativePath(input.workspacePath, file)}`, "pyproject.toml mentions mypy.");
  }

  for (const file of findFiles(input.workspacePath, "Cargo.toml", 4)) {
    const cwd = relativePath(input.workspacePath, path.dirname(file)) || ".";
    add("cargo test", cwd, "test", `cargo:${relativePath(input.workspacePath, file)}`, "Cargo.toml detected.");
    add("cargo check", cwd, "typecheck", `cargo:${relativePath(input.workspacePath, file)}`, "Cargo.toml detected.");
  }

  const readme = path.join(input.workspacePath, "README.md");
  for (const command of extractReadmeValidationCommands(safeRead(readme))) {
    add(command.command, ".", command.kind, "README.md", "README instructions mention a validation command.");
  }

  for (const command of readCommandInventory(input.workspacePath)) {
    add(command.command, command.cwd, normalizeInventoryKind(command.kind), `command_inventory:${command.sourceFile ?? command.source ?? command.command}`, "Existing command inventory entry.");
  }

  for (const command of input.projectMap?.testCommands ?? []) {
    add(command, ".", "test", "project_summary:testCommands", "Project summary test command.");
  }

  return dedupeDiscoveredCommands(commands).sort((left, right) =>
    classificationOrder(left.classification) - classificationOrder(right.classification)
    || kindOrder(left.kind) - kindOrder(right.kind)
    || left.cwd.localeCompare(right.cwd)
    || left.command.localeCompare(right.command)
  );
}

export function selectRecursiveValidationStrategy(input: {
  discoveredCommands: RecursiveDiscoveredValidationCommand[];
  patches: PatchProposal[];
  branchId?: string;
  exactPatchEffectAllowed: boolean;
}): RecursiveValidationStrategy {
  const preferred = input.discoveredCommands.find((command) => command.classification === "safe_auto" && isPreferredKind(command.kind));
  if (preferred) {
    return {
      kind: "command",
      command: preferred.command,
      cwd: preferred.cwd,
      classification: preferred.classification,
      scope: "project",
      reason: `Selected safest discovered ${preferred.kind} command from ${preferred.source}.`,
      source: preferred.source
    };
  }
  const needsApproval = input.discoveredCommands.find((command) => command.classification === "needs_approval");
  if (needsApproval) {
    return {
      kind: "command",
      command: needsApproval.command,
      cwd: needsApproval.cwd,
      classification: "needs_approval",
      scope: "project",
      reason: `Validation command exists but Rust policy requires approval: ${needsApproval.reason}`,
      source: needsApproval.source
    };
  }
  const blocked = input.discoveredCommands.find((command) => command.classification === "blocked");
  if (blocked) {
    return {
      kind: "command",
      command: blocked.command,
      cwd: blocked.cwd,
      classification: "blocked",
      scope: "project",
      reason: `Validation command is blocked by policy: ${blocked.reason}`,
      source: blocked.source
    };
  }
  if (input.exactPatchEffectAllowed && input.patches.some((patch) => patch.status === "applied" && patch.artifacts?.length)) {
    const files = input.patches.flatMap((patch) => patch.filesChanged.map((file) => file.path));
    return {
      kind: "patch_effect",
      classification: "safe_auto",
      scope: "patch_effect",
      reason: `No project validation command was available; selected exact patch-effect validation for ${files.slice(0, 4).join(", ")}. This does not prove whole-project correctness.`
    };
  }
  return {
    kind: "missing",
    classification: "missing",
    scope: "none",
    reason: "No safe validation command was discovered and exact patch-effect validation was not available."
  };
}

export function buildRecursiveValidationCommandRequest(input: {
  sessionId: string;
  workspacePath: string;
  strategy: RecursiveValidationStrategy;
}): CommandRequest | undefined {
  if (input.strategy.kind !== "command" || !input.strategy.command) return undefined;
  const cwd = resolveInsideWorkspace(input.workspacePath, input.strategy.cwd ?? ".");
  const risk = classifyCommandRisk(input.strategy.command, input.workspacePath);
  const normalized = input.strategy.command.toLowerCase();
  return {
    id: `cmd_recursive_validation_${cryptoRandomId()}`,
    sessionId: input.sessionId,
    command: input.strategy.command,
    cwd,
    risk,
    reason: [
      "Recursive validation request. Runtime selected this command but Rust TerminalService must approve and execute it.",
      input.strategy.reason
    ].join(" "),
    provenance: {
      source: "agent",
      trigger: "manual",
      requestedBy: "agent",
      approvalSource: risk === "dangerous" ? "denied" : "none",
      policyDecision: risk === "dangerous" ? "deny" : risk === "safe" ? "allow" : "require_approval",
      policyReason: input.strategy.reason,
      executionAuthority: "rust",
      background: looksLikeBackgroundCommand(normalized),
      networkDetected: looksLikeNetworkCommand(normalized),
      backgroundDetected: looksLikeBackgroundCommand(normalized),
      detectionSource: risk === "safe" ? "policy" : "heuristic",
      networkDetectionSource: looksLikeNetworkCommand(normalized) ? "heuristic" : "unknown",
      backgroundDetectionSource: looksLikeBackgroundCommand(normalized) ? "heuristic" : "unknown",
      reason: input.strategy.reason
    },
    status: risk === "dangerous" ? "blocked" : "requested",
    createdAt: new Date().toISOString()
  };
}

export function findRecursiveValidationEvidence(input: {
  session: AgentRuntimeSession;
  strategy: RecursiveValidationStrategy;
  patches: PatchProposal[];
}): RecursiveValidationEvidence[] {
  if (input.strategy.kind === "command" && input.strategy.command) {
    const matchingRequests = input.session.commandRequests.filter((request) =>
      normalizeCommand(request.command) === normalizeCommand(input.strategy.command!)
      && path.resolve(request.cwd) === path.resolve(resolveInsideWorkspace(input.session.workspacePath, input.strategy.cwd ?? "."))
    );
    const requestIds = new Set(matchingRequests.map((request) => request.id));
    const executions = input.session.commandExecutions.filter((execution) =>
      requestIds.has(execution.requestId ?? "")
      || normalizeCommand(execution.command) === normalizeCommand(input.strategy.command!)
    );
    const latest = executions.at(-1);
    if (!latest) return [];
    return [commandEvidence(latest)];
  }
  if (input.strategy.kind === "patch_effect") {
    return [patchEffectEvidence(input.session.workspacePath, input.patches)];
  }
  return [];
}

export function truthFromRecursiveValidation(input: {
  strategy: RecursiveValidationStrategy;
  evidence: RecursiveValidationEvidence[];
}): ValidationTruthStatus {
  const latest = input.evidence.at(-1);
  if (latest) return latest.truthStatus;
  if (input.strategy.classification === "blocked") return "not_run_blocked_by_policy";
  if (input.strategy.classification === "needs_approval") return "not_run_needs_approval";
  if (input.strategy.classification === "missing") return "not_run_missing_command";
  return "unverified";
}

function commandEvidence(execution: CommandExecutionRecord): RecursiveValidationEvidence {
  const passed = (execution.status === "executed" || execution.status === "completed") && (execution.exitCode === undefined || execution.exitCode === 0);
  const failed = execution.status === "failed"
    || ((execution.status === "executed" || execution.status === "completed") && typeof execution.exitCode === "number" && execution.exitCode !== 0);
  const truthStatus: ValidationTruthStatus = failed
    ? "verified_failed"
    : execution.status === "blocked"
      ? "not_run_blocked_by_policy"
      : execution.status === "approval_required"
        ? "not_run_needs_approval"
        : execution.status === "orphaned" || execution.status === "terminated" || execution.status === "unknown"
          ? "not_run_runtime_error"
          : passed
            ? "verified_passed"
            : "unverified";
  return {
    kind: "command",
    truthStatus,
    summary: passed
      ? "Rust TerminalService executed the selected validation command successfully."
      : execution.message ?? `Rust TerminalService reported ${execution.status}.`,
    command: execution.command,
    cwd: execution.cwd,
    requestId: execution.requestId,
    executionId: execution.id,
    exitCode: execution.exitCode,
    policyResult: execution.provenance?.policyDecision,
    stdoutSummary: summarizeOutput(execution.stdout),
    stderrSummary: summarizeOutput(execution.stderr),
    scope: "project"
  };
}

function patchEffectEvidence(workspacePath: string, patches: PatchProposal[]): RecursiveValidationEvidence {
  const applied = patches.filter((patch) => patch.status === "applied");
  const files: string[] = [];
  const mismatches: string[] = [];
  for (const patch of applied) {
    for (const artifact of patch.artifacts ?? []) {
      const artifactPath = artifact.path || patch.filesChanged[0]?.path;
      if (!artifactPath) continue;
      files.push(artifactPath);
      try {
        const disk = fs.readFileSync(resolveInsideWorkspace(workspacePath, artifactPath), "utf8").replace(/\r\n/g, "\n");
        const expected = artifact.content.replace(/\r\n/g, "\n");
        if (disk !== expected) mismatches.push(artifactPath);
      } catch {
        mismatches.push(artifactPath);
      }
    }
  }
  return {
    kind: "patch_effect",
    truthStatus: applied.length && files.length && !mismatches.length ? "verified_passed" : "verified_failed",
    summary: applied.length && files.length && !mismatches.length
      ? "Exact patch-effect validation matched applied patch artifacts on disk. This only verifies the scoped smoke change, not whole-project correctness."
      : `Exact patch-effect validation failed for ${mismatches.join(", ") || "missing applied patch artifacts"}.`,
    files,
    scope: "patch_effect"
  };
}

function classifyDiscoveredValidationCommand(input: {
  command: string;
  cwd: string;
  kind: RecursiveDiscoveredValidationCommand["kind"];
  source: string;
  reason: string;
  workspacePath: string;
  forceBlocked?: boolean;
}): RecursiveDiscoveredValidationCommand {
  const risk = classifyCommandRisk(input.command, input.workspacePath);
  const normalized = input.command.toLowerCase();
  const network = looksLikeNetworkCommand(normalized);
  const background = looksLikeBackgroundCommand(normalized);
  const classification = input.forceBlocked || risk === "dangerous" || network
    ? "blocked"
    : risk === "safe" && !background
      ? "safe_auto"
      : "needs_approval";
  return {
    command: input.command,
    cwd: input.cwd || ".",
    kind: input.kind,
    source: input.source,
    classification,
    risk,
    reason: classification === "blocked"
      ? `${input.reason} Network/install/dangerous commands cannot auto-run.`
      : classification === "needs_approval"
        ? `${input.reason} Rust policy requires explicit approval.`
        : input.reason
  };
}

function looksLikeInstallOrNetworkScript(body: string) {
  const normalized = body.toLowerCase();
  return /\b(npm|pnpm|yarn|pip|cargo)\s+(install|i|add)\b/.test(normalized)
    || /\b(curl|wget|invoke-webrequest|iwr|irm)\b/.test(normalized);
}

function findFiles(workspacePath: string, basename: string, maxDepth: number) {
  const found: string[] = [];
  const root = resolveInsideWorkspace(workspacePath);
  const walk = (dir: string, depth: number) => {
    if (depth > maxDepth || found.length >= 20) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === ".agent_memory" || entry.name === "target" || entry.name === "dist") continue;
      const full = path.join(dir, entry.name);
      if (entry.isFile() && entry.name === basename) found.push(full);
      if (entry.isDirectory()) walk(full, depth + 1);
    }
  };
  walk(root, 0);
  return found;
}

function readCommandInventory(workspacePath: string): Array<{ command: string; cwd: string; kind: string; sourceFile?: string; source?: string }> {
  const inventory = readMemorySnapshotSync<CommandInventory>(workspacePath, "command_inventory");
  return (inventory?.commands ?? []).filter((entry): entry is CommandInventory["commands"][number] =>
    typeof entry.command === "string"
    && typeof entry.cwd === "string"
    && typeof entry.kind === "string"
  );
}

function extractReadmeValidationCommands(text: string): Array<{ command: string; kind: RecursiveDiscoveredValidationCommand["kind"] }> {
  const commands: Array<{ command: string; kind: RecursiveDiscoveredValidationCommand["kind"] }> = [];
  for (const match of text.matchAll(/(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:test|typecheck|lint|build|smoke)(?:[^\r\n`]*)/gi)) {
    const command = match[0]?.trim();
    if (command) commands.push({ command, kind: classifyValidationKind(command, command) });
  }
  for (const match of text.matchAll(/(?:cargo\s+(?:test|check)|pytest|python\s+-m\s+pytest|ruff\s+check\s+\.|mypy\s+\.)(?:[^\r\n`]*)/gi)) {
    const command = match[0]?.trim();
    if (command) commands.push({ command, kind: classifyValidationKind(command, command) });
  }
  return commands.filter((entry) => isValidationKind(entry.kind));
}

function classifyValidationKind(name: string, body: string): RecursiveDiscoveredValidationCommand["kind"] {
  const value = `${name} ${body}`.toLowerCase();
  if (/\btest|pytest|jest|vitest|cargo test|node --test\b/.test(value)) return "test";
  if (/\btypecheck|type-check|tsc|mypy|cargo check\b/.test(value)) return "typecheck";
  if (/\blint|eslint|ruff|clippy\b/.test(value)) return "lint";
  if (/\bsmoke|e2e|verify\b/.test(value)) return "smoke";
  if (/\bbuild|compile\b/.test(value)) return "build";
  return "unknown";
}

function normalizeInventoryKind(kind: string): RecursiveDiscoveredValidationCommand["kind"] {
  return kind === "test" || kind === "lint" || kind === "typecheck" || kind === "build" || kind === "smoke" ? kind : "unknown";
}

function isValidationKind(kind: RecursiveDiscoveredValidationCommand["kind"]) {
  return kind === "test" || kind === "typecheck" || kind === "lint" || kind === "smoke" || kind === "build";
}

function isPreferredKind(kind: RecursiveDiscoveredValidationCommand["kind"]) {
  return kind === "test" || kind === "typecheck" || kind === "lint" || kind === "smoke";
}

function packageManagerForPackage(declared: string | undefined, workspacePath: string, packageFile: string) {
  if (declared?.startsWith("pnpm")) return "pnpm";
  if (declared?.startsWith("yarn")) return "yarn";
  const root = path.resolve(workspacePath);
  const dir = path.dirname(packageFile);
  if (fs.existsSync(path.join(root, "pnpm-lock.yaml")) || fs.existsSync(path.join(dir, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(root, "yarn.lock")) || fs.existsSync(path.join(dir, "yarn.lock"))) return "yarn";
  return "npm";
}

function packageRunCommand(packageManager: string, scriptName: string) {
  if (packageManager === "pnpm") return `pnpm run ${scriptName}`;
  if (packageManager === "yarn") return `yarn ${scriptName}`;
  return scriptName === "test" ? "npm test" : `npm run ${scriptName}`;
}

function dedupeDiscoveredCommands(commands: RecursiveDiscoveredValidationCommand[]) {
  const byKey = new Map<string, RecursiveDiscoveredValidationCommand>();
  for (const command of commands) {
    const key = `${command.cwd}:${normalizeCommand(command.command)}`;
    const existing = byKey.get(key);
    if (!existing || classificationOrder(command.classification) < classificationOrder(existing.classification) || kindOrder(command.kind) < kindOrder(existing.kind)) {
      byKey.set(key, command);
    }
  }
  return [...byKey.values()];
}

function classificationOrder(value: RecursiveDiscoveredValidationCommand["classification"]) {
  return value === "safe_auto" ? 0 : value === "needs_approval" ? 1 : value === "blocked" ? 2 : 3;
}

function kindOrder(value: RecursiveDiscoveredValidationCommand["kind"]) {
  return VALIDATION_KIND_ORDER.indexOf(value as typeof VALIDATION_KIND_ORDER[number]);
}

function relativePath(workspacePath: string, fullPath: string) {
  const relative = path.relative(workspacePath, fullPath).replaceAll("\\", "/");
  return relative === "" ? "." : relative;
}

function safeRead(filePath: string) {
  try {
    return fs.readFileSync(filePath, "utf8").slice(0, 80_000);
  } catch {
    return "";
  }
}

function normalizeCommand(command: string) {
  return command.replace(/\s+/g, " ").trim().toLowerCase();
}

function summarizeOutput(value: string | undefined, limit = 240) {
  const compact = (value ?? "").replace(/\s+/g, " ").trim();
  if (!compact) return undefined;
  return compact.length > limit ? `${compact.slice(0, limit - 3)}...` : compact;
}

function cryptoRandomId() {
  return randomUUID();
}
