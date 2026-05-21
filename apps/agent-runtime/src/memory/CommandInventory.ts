import type { CommandInventory, CommandInventoryEntry, CommandKind, FileManifestEntry } from "./types.js";
import { MEMORY_SCHEMA_VERSION } from "./types.js";

type FileTextLookup = Map<string, string>;

const COMMAND_KINDS: CommandKind[] = ["test", "lint", "typecheck", "build", "format", "smoke", "dev", "run", "unknown"];

export function buildCommandInventory(input: {
  generatedAt: string;
  files: FileManifestEntry[];
  fileText: FileTextLookup;
}): CommandInventory {
  const commands: CommandInventoryEntry[] = [];
  const packageManagers = new Set<string>();
  const filesByPath = new Set(input.files.map((file) => file.path));

  if (filesByPath.has("package-lock.json")) packageManagers.add("npm");
  if (filesByPath.has("pnpm-lock.yaml")) packageManagers.add("pnpm");
  if (filesByPath.has("yarn.lock")) packageManagers.add("yarn");
  if (input.files.some((file) => file.basename === "Cargo.toml")) packageManagers.add("cargo");
  if (input.files.some((file) => file.basename === "go.mod")) packageManagers.add("go");
  if (input.files.some((file) => file.basename === "pyproject.toml" || file.basename === "requirements.txt")) packageManagers.add("python");

  for (const file of input.files) {
    const text = input.fileText.get(file.path);
    if (!text) continue;
    if (file.basename === "package.json") {
      commands.push(...commandsFromPackageJson(file, text, packageManagers));
    } else if (file.basename === "Cargo.toml") {
      commands.push(...commandsFromCargo(file));
    } else if (file.basename === "go.mod") {
      commands.push(...commandsFromGo(file));
    } else if (file.basename === "pyproject.toml" || file.basename === "requirements.txt") {
      commands.push(...commandsFromPython(file, text));
    } else if (/^makefile$/i.test(file.basename)) {
      commands.push(...commandsFromMake(file, text));
    } else if (/^justfile$/i.test(file.basename)) {
      commands.push(...commandsFromJust(file, text));
    } else if (file.basename === "composer.json") {
      commands.push(...commandsFromComposer(file, text));
    } else if (file.basename === "Gemfile") {
      commands.push(...commandsFromGem(file));
    } else if (/^(build\.gradle|settings\.gradle|gradlew)$/i.test(file.basename)) {
      commands.push(...commandsFromGradle(file));
    } else if (file.path.startsWith(".github/workflows/") && /\.(ya?ml)$/i.test(file.path)) {
      commands.push(...commandsFromWorkflow(file, text));
    }
  }

  const deduped = dedupeCommands(commands).sort(
    (left, right) =>
      kindOrder(left.kind) - kindOrder(right.kind) ||
      left.cwd.localeCompare(right.cwd) ||
      left.command.localeCompare(right.command)
  );
  const byKind = createEmptyByKind();
  for (const command of deduped) {
    byKind[command.kind].push(command.command);
  }

  return {
    schemaVersion: MEMORY_SCHEMA_VERSION,
    generatedAt: input.generatedAt,
    packageManagers: [...packageManagers].sort(),
    commands: deduped,
    byKind
  };
}

function commandsFromPackageJson(file: FileManifestEntry, text: string, packageManagers: Set<string>): CommandInventoryEntry[] {
  try {
    const parsed = JSON.parse(text) as { scripts?: Record<string, string>; packageManager?: string };
    const packageManager = packageManagerForPackage(file, packageManagers, parsed.packageManager);
    if (packageManager) packageManagers.add(packageManager);
    return Object.entries(parsed.scripts ?? {}).map(([scriptName, script]) => {
      const kind = classifyScript(scriptName, script);
      return {
        id: commandId(file.dirname, `package:${scriptName}`),
        kind,
        command: packageRunCommand(packageManager, scriptName),
        cwd: file.dirname || ".",
        sourceFile: file.path,
        source: "package_json" as const,
        packageManager: packageManager ?? "npm",
        scriptName,
        confidence: kind === "unknown" ? "medium" : "high",
        notes: [`script: ${script}`]
      };
    });
  } catch {
    return [];
  }
}

function commandsFromCargo(file: FileManifestEntry): CommandInventoryEntry[] {
  return ["cargo test", "cargo check", "cargo build"].map((command) => ({
    id: commandId(file.dirname, command),
    kind: command.includes("test") ? "test" : command.includes("check") ? "typecheck" : "build",
    command,
    cwd: file.dirname || ".",
    sourceFile: file.path,
    source: "cargo" as const,
    packageManager: "cargo",
    confidence: "medium" as const
  }));
}

function commandsFromGo(file: FileManifestEntry): CommandInventoryEntry[] {
  return [
    {
      id: commandId(file.dirname, "go test ./..."),
      kind: "test" as const,
      command: "go test ./...",
      cwd: file.dirname || ".",
      sourceFile: file.path,
      source: "go" as const,
      packageManager: "go",
      confidence: "medium" as const
    },
    {
      id: commandId(file.dirname, "go build ./..."),
      kind: "build" as const,
      command: "go build ./...",
      cwd: file.dirname || ".",
      sourceFile: file.path,
      source: "go" as const,
      packageManager: "go",
      confidence: "medium" as const
    }
  ];
}

function commandsFromPython(file: FileManifestEntry, text: string): CommandInventoryEntry[] {
  const commands: CommandInventoryEntry[] = [];
  const cwd = file.dirname || ".";
  if (/pytest|tool\.pytest|unittest/i.test(text) || file.basename === "requirements.txt") {
    commands.push({
      id: commandId(cwd, "pytest"),
      kind: "test",
      command: "pytest",
      cwd,
      sourceFile: file.path,
      source: "python",
      packageManager: "python",
      confidence: /pytest/i.test(text) ? "high" : "low"
    });
  }
  if (/ruff/i.test(text)) {
    commands.push({
      id: commandId(cwd, "ruff check ."),
      kind: "lint",
      command: "ruff check .",
      cwd,
      sourceFile: file.path,
      source: "python",
      packageManager: "python",
      confidence: "medium"
    });
  }
  if (/mypy/i.test(text)) {
    commands.push({
      id: commandId(cwd, "mypy ."),
      kind: "typecheck",
      command: "mypy .",
      cwd,
      sourceFile: file.path,
      source: "python",
      packageManager: "python",
      confidence: "medium"
    });
  }
  return commands;
}

function commandsFromMake(file: FileManifestEntry, text: string): CommandInventoryEntry[] {
  return extractTargets(text)
    .filter((target) => !target.includes("%"))
    .slice(0, 30)
    .map((target) => ({
      id: commandId(file.dirname, `make ${target}`),
      kind: classifyScript(target, ""),
      command: `make ${target}`,
      cwd: file.dirname || ".",
      sourceFile: file.path,
      source: "make" as const,
      packageManager: "make",
      scriptName: target,
      confidence: "medium" as const
    }));
}

function commandsFromJust(file: FileManifestEntry, text: string): CommandInventoryEntry[] {
  return extractTargets(text)
    .slice(0, 30)
    .map((target) => ({
      id: commandId(file.dirname, `just ${target}`),
      kind: classifyScript(target, ""),
      command: `just ${target}`,
      cwd: file.dirname || ".",
      sourceFile: file.path,
      source: "just" as const,
      packageManager: "just",
      scriptName: target,
      confidence: "medium" as const
    }));
}

function commandsFromComposer(file: FileManifestEntry, text: string): CommandInventoryEntry[] {
  try {
    const parsed = JSON.parse(text) as { scripts?: Record<string, unknown> };
    return Object.keys(parsed.scripts ?? {}).map((scriptName) => ({
      id: commandId(file.dirname, `composer ${scriptName}`),
      kind: classifyScript(scriptName, ""),
      command: `composer ${scriptName}`,
      cwd: file.dirname || ".",
      sourceFile: file.path,
      source: "composer" as const,
      packageManager: "composer",
      scriptName,
      confidence: "medium" as const
    }));
  } catch {
    return [];
  }
}

function commandsFromGem(file: FileManifestEntry): CommandInventoryEntry[] {
  return [{
    id: commandId(file.dirname, "bundle exec rake test"),
    kind: "test",
    command: "bundle exec rake test",
    cwd: file.dirname || ".",
    sourceFile: file.path,
    source: "gem" as const,
    packageManager: "bundler",
    confidence: "low"
  }];
}

function commandsFromGradle(file: FileManifestEntry): CommandInventoryEntry[] {
  const cwd = file.dirname || ".";
  return ["./gradlew test", "./gradlew build"].map((command) => ({
    id: commandId(cwd, command),
    kind: command.includes("test") ? "test" as const : "build" as const,
    command,
    cwd,
    sourceFile: file.path,
    source: "gradle" as const,
    packageManager: "gradle",
    confidence: "low" as const
  }));
}

function commandsFromWorkflow(file: FileManifestEntry, text: string): CommandInventoryEntry[] {
  const commands: CommandInventoryEntry[] = [];
  for (const match of text.matchAll(/run:\s*(.+)$/gim)) {
    const command = match[1]?.trim().replace(/^["']|["']$/g, "");
    if (!command || command.length > 180) continue;
    const kind = classifyScript(command, command);
    if (kind === "unknown") continue;
    commands.push({
      id: commandId(file.dirname, `ci:${command}`),
      kind,
      command,
      cwd: ".",
      sourceFile: file.path,
      source: "ci",
      confidence: "low",
      notes: ["Detected from CI workflow run step."]
    });
  }
  return commands;
}

function packageManagerForPackage(file: FileManifestEntry, managers: Set<string>, declared?: string) {
  if (declared?.startsWith("pnpm")) return "pnpm";
  if (declared?.startsWith("yarn")) return "yarn";
  if (declared?.startsWith("npm")) return "npm";
  if (file.dirname === ".") {
    if (managers.has("pnpm")) return "pnpm";
    if (managers.has("yarn")) return "yarn";
    return "npm";
  }
  if (managers.has("pnpm")) return "pnpm";
  if (managers.has("yarn")) return "yarn";
  return "npm";
}

function packageRunCommand(packageManager: string | undefined, scriptName: string) {
  if (packageManager === "pnpm") return `pnpm run ${scriptName}`;
  if (packageManager === "yarn") return `yarn ${scriptName}`;
  return `npm run ${scriptName}`;
}

function classifyScript(name: string, body: string): CommandKind {
  const scriptName = name.toLowerCase();
  if (/\b(typecheck|type-check|check-types)\b/.test(scriptName)) return "typecheck";
  if (/\b(lint)\b/.test(scriptName)) return "lint";
  if (/\b(test|spec)\b/.test(scriptName)) return "test";
  if (/\b(build|compile|bundle)\b/.test(scriptName)) return "build";
  if (/\b(format|fmt)\b/.test(scriptName)) return "format";
  if (/\b(smoke|verify|health|e2e)\b/.test(scriptName)) return "smoke";
  if (/\b(dev|watch|serve)\b/.test(scriptName)) return "dev";
  if (/\b(start|run|launch)\b/.test(scriptName)) return "run";
  const text = `${name} ${body}`.toLowerCase();
  if (/\b(typecheck|type-check|tsc|mypy|check-types)\b/.test(text)) return "typecheck";
  if (/\b(lint|eslint|ruff|clippy|flake8|stylelint)\b/.test(text)) return "lint";
  if (/\b(test|spec|jest|vitest|pytest|cargo test|go test|mocha|ava|tap)\b/.test(text)) return "test";
  if (/\b(build|compile|bundle|vite build|cargo build|go build|tauri build)\b/.test(text)) return "build";
  if (/\b(format|fmt|prettier|black|cargo fmt|gofmt)\b/.test(text)) return "format";
  if (/\b(smoke|verify|health|check|e2e)\b/.test(text)) return "smoke";
  if (/\b(dev|watch|serve)\b/.test(text)) return "dev";
  if (/\b(start|run|launch)\b/.test(text)) return "run";
  return "unknown";
}

function extractTargets(text: string) {
  return [...text.matchAll(/^([A-Za-z0-9_.-]+)\s*:(?![=])/gm)]
    .map((match) => match[1])
    .filter((target): target is string => Boolean(target) && !target.startsWith("."));
}

function dedupeCommands(commands: CommandInventoryEntry[]) {
  const byKey = new Map<string, CommandInventoryEntry>();
  for (const command of commands) {
    const key = `${command.cwd}:${command.command}`;
    const existing = byKey.get(key);
    if (!existing || confidenceRank(command.confidence) > confidenceRank(existing.confidence)) {
      byKey.set(key, command);
    }
  }
  return [...byKey.values()];
}

function confidenceRank(value: CommandInventoryEntry["confidence"]) {
  return value === "high" ? 3 : value === "medium" ? 2 : 1;
}

function commandId(cwd: string, command: string) {
  const normalized = `${cwd || "."}:${command}`.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return `cmd_${normalized.slice(0, 80)}`;
}

function kindOrder(kind: CommandKind) {
  return COMMAND_KINDS.indexOf(kind);
}

function createEmptyByKind(): Record<CommandKind, string[]> {
  return {
    test: [],
    lint: [],
    typecheck: [],
    build: [],
    format: [],
    smoke: [],
    dev: [],
    run: [],
    unknown: []
  };
}
