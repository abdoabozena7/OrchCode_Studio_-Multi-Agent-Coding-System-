import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, statSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const auditDir = path.join(root, "tmp/full-system-audit");
const logsDir = path.join(auditDir, "command-logs");
const screenshotDir = path.join(auditDir, "screenshots");

function read(rel) {
  const abs = path.join(root, rel);
  if (!existsSync(abs)) return "";
  const bytes = readFileSync(abs);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.toString("utf16le");
  const sample = bytes.subarray(0, Math.min(bytes.length, 80));
  const nulCount = [...sample].filter((byte) => byte === 0).length;
  if (nulCount > sample.length / 4) return bytes.toString("utf16le");
  return bytes.toString("utf8");
}

function readJson(rel, fallback = null) {
  try {
    return JSON.parse(read(rel));
  } catch {
    return fallback;
  }
}

function firstJsonObject(text) {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "{") depth += 1;
    if (ch === "}") depth -= 1;
    if (depth === 0) {
      try {
        return JSON.parse(text.slice(start, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

function rgFiles() {
  return execSync("rg --files", { cwd: root, encoding: "utf8" })
    .split(/\r?\n/)
    .filter(Boolean);
}

const sourceFiles = rgFiles();
const sourceWithoutAuditTmp = sourceFiles.filter((file) => !file.startsWith("tmp/") && !file.startsWith("tmp\\"));
const byTop = new Map();
for (const file of sourceFiles) {
  const top = file.split(/[\\/]/)[0];
  byTop.set(top, (byTop.get(top) ?? 0) + 1);
}

const packageJson = readJson("package.json", {});
const realProviderSmoke = readJson("tmp/full-system-audit/real-provider-smoke.json", {});
const inspectAnswers = readJson("tmp/full-system-audit/answers.json", []);
const inspectFailures = readJson("tmp/full-system-audit/failures.json", []);
const sqliteState = firstJsonObject(read("tmp/full-system-audit/command-logs/sqlite-state.log"));
const sqliteProvider = firstJsonObject(read("tmp/full-system-audit/command-logs/sqlite-provider-session.log"));
const desktopDomSnapshot = read("tmp/full-system-audit/screenshots/desktop-vite-dom-snapshot.txt");

const commandResults = [
  ["npm run typecheck", "passed", "tmp/full-system-audit/command-logs/npm-run-typecheck.log"],
  ["npm test", "passed", "tmp/full-system-audit/command-logs/npm-test.log"],
  ["npm run build -w @orchcode/desktop", "passed", "tmp/full-system-audit/command-logs/npm-build-desktop.log"],
  ["cargo test", "passed", "tmp/full-system-audit/command-logs/cargo-test-tauri.log"],
  ["npm run smoke:run-to-green", "passed", "tmp/full-system-audit/command-logs/smoke-run-to-green.log"],
  ["npm run smoke:desktop-run-project", "passed", "tmp/full-system-audit/command-logs/smoke-desktop-run-project.log"],
  ["npm run memory:index-status", "passed", "tmp/full-system-audit/command-logs/memory-index-status.log"],
  ["npm run memory:inspect", "passed", "tmp/full-system-audit/command-logs/memory-inspect.log"],
  ["npm run memory:show-commands", "passed", "tmp/full-system-audit/command-logs/memory-show-commands.log"],
  ["npm run agent:trial:staffing-eval", "passed", "tmp/full-system-audit/command-logs/agent-trial-staffing-eval.log"],
  ["npm run agent:trial:scheduler-scale", "passed", "tmp/full-system-audit/command-logs/agent-trial-scheduler-scale.log"],
  ["npm run agent:trial:compare", "passed", "tmp/full-system-audit/command-logs/agent-trial-compare.log"],
  ["npm run agent:plan", "passed", "tmp/full-system-audit/command-logs/agent-plan.log"],
  ["runtime health injection", "passed", "tmp/full-system-audit/command-logs/runtime-health-inject-retry.log"],
  ["SQLite state inspection", "passed", "tmp/full-system-audit/command-logs/sqlite-state.log"],
  ["SQLite provider/session inspection", "passed", "tmp/full-system-audit/command-logs/sqlite-provider-session.log"],
  ["desktop Vite dev server for DOM capture", "started_then_stopped", "tmp/full-system-audit/command-logs/desktop-vite-dev.log"],
  ["real provider smoke", realProviderSmoke?.runtimeRealProvider?.status === "completed" ? "passed" : "unknown", "tmp/full-system-audit/real-provider-smoke.json"],
  ["inspect/explain prompts with real_provider", inspectFailures.length ? "failed" : "completed_with_provider_timeouts", "tmp/full-system-audit/inspect-explain-reality-report.md"],
  ["desktop Vite web UI DOM capture", desktopDomSnapshot ? "dom_verified_screenshot_failed" : "not_verified", "tmp/full-system-audit/screenshots/desktop-vite-dom-snapshot.txt"],
  ["audit artifact generation", "passed", "tmp/full-system-audit/command-logs/write-audit-artifacts.log"]
].map(([command, status, log]) => ({ command, status, log }));

const statuses = {
  realWired: "Real and wired",
  realNotWired: "Real but not wired to main path",
  partial: "Partial",
  mock: "Mock/test-only",
  docs: "Docs-only",
  broken: "Broken",
  missing: "Missing",
  unknown: "Unknown"
};

const capabilityMatrix = [
  {
    phase: 1,
    capability: "persistent memory",
    claimed: true,
    status: statuses.realNotWired,
    implemented: "Project memory and repo index files exist under .agent_memory; CLI commands inspect and refresh them.",
    wired: "Swarm/CLI uses memory; desktop RunEngine ProjectIntake reads live workspace instead of the committed repo index.",
    ui: "No direct UI surface for memory freshness or memory contents was verified.",
    cli: "memory:index-status, memory:inspect, memory:show-commands passed.",
    provider: "none",
    mocks: "no model required",
    evidence: [".agent_memory/README.md", "apps/agent-runtime/src/memory/RepoIndexer.ts", "tmp/full-system-audit/command-logs/memory-inspect.log"]
  },
  {
    phase: 1,
    capability: "repository indexing",
    claimed: true,
    status: statuses.realNotWired,
    implemented: "Repo index totals reported 249 indexed files and fresh status before audit.",
    wired: "Used by swarm planner/trial lab; not the normal desktop inspect/run intake path.",
    ui: "not visible",
    cli: "memory:index-status passed",
    provider: "none",
    mocks: "none",
    evidence: ["apps/agent-runtime/src/memory/RepoIndexer.ts", "apps/agent-runtime/src/orchestration/SwarmRuntime.ts:300", "tmp/full-system-audit/command-logs/memory-index-status.log"]
  },
  {
    phase: 1,
    capability: "command inventory",
    claimed: true,
    status: statuses.partial,
    implemented: "Command inventory exists and is reported, but duplicate/noisy command entries were observed.",
    wired: "Used by swarm validation command selection, not primary run-to-green command selection.",
    ui: "not visible",
    cli: "memory:show-commands passed",
    provider: "none",
    mocks: "none",
    evidence: ["apps/agent-runtime/src/memory/CommandInventory.ts", "apps/agent-runtime/src/orchestration/SwarmRuntime.ts:362", "tmp/full-system-audit/command-logs/memory-show-commands.log"]
  },
  {
    phase: 2,
    capability: "orchestrator",
    claimed: true,
    status: statuses.realNotWired,
    implemented: "CoreOrchestrator and CLI commands exist; tests pass.",
    wired: "Desktop normal submit goes through AgentRuntime/RunEngine unless auto-mode selects orchestration; no UI control for campaigns/swarm was verified.",
    ui: "not directly visible in Vite DOM",
    cli: "run-agentic-task/plan-task and agent plan available",
    provider: "mostly mock/deterministic in tests",
    mocks: "unit tests use mock providers",
    evidence: ["apps/agent-runtime/src/orchestration/Orchestrator.ts", "apps/agent-runtime/src/orchestration/cli.ts:48", "tmp/full-system-audit/command-logs/agent-plan.log"]
  },
  {
    phase: 2,
    capability: "task graph",
    claimed: true,
    status: statuses.realNotWired,
    implemented: "Task graph manager, scheduler package, and orchestration task artifacts exist.",
    wired: "CLI/campaign path; main desktop run-to-green creates runtime task state, not full task graph UX.",
    ui: "generic details/activity only",
    cli: "agent plan emits work graph artifacts",
    provider: "none required",
    mocks: "worker execution often mock",
    evidence: ["apps/agent-runtime/src/orchestration/TaskGraphManager.ts", "apps/agent-runtime/src/scheduler/TaskGraph.ts", "tmp/full-system-audit/command-logs/agent-plan.log"]
  },
  {
    phase: 2,
    capability: "context packs",
    claimed: true,
    status: statuses.partial,
    implemented: "RunEngine stores context_pack artifact; ContextPackBuilder exists for orchestration.",
    wired: "Inspect/run creates artifacts, but UI does not make context packs a first-class operator view.",
    ui: "not surfaced in captured startup DOM",
    cli: "show-context-pack exists",
    provider: "not inherently",
    mocks: "none",
    evidence: ["apps/agent-runtime/src/runtime/RunEngine.ts:92", "apps/agent-runtime/src/orchestration/ContextPackBuilder.ts", "apps/agent-runtime/src/orchestration/cli.ts:104"]
  },
  {
    phase: 3,
    capability: "safety",
    claimed: true,
    status: statuses.realWired,
    implemented: "Rust command policy and patch path guards exist; risky command smoke blocked git push.",
    wired: "Desktop command execution uses Rust execute_approved_command.",
    ui: "Full Access visible; command approvals inferred from source/smoke, not native E2E.",
    cli: "smoke:desktop-run-project passed",
    provider: "none",
    mocks: "smoke uses temp workspaces",
    evidence: ["apps/desktop/src-tauri/src/services/command_policy.rs", "apps/desktop/src-tauri/src/commands/terminal.rs:33", "tmp/full-system-audit/command-logs/smoke-desktop-run-project.log"]
  },
  {
    phase: 3,
    capability: "review",
    claimed: true,
    status: statuses.partial,
    implemented: "ReviewLoop, reviewer agents, and review schemas exist.",
    wired: "Orchestration/swarm paths create review artifacts; desktop edit loop not proven to invoke real review agents.",
    ui: "not first-class in startup DOM",
    cli: "orchestration CLI",
    provider: "mock or deterministic in tests",
    mocks: "many tests",
    evidence: ["apps/agent-runtime/src/orchestration/ReviewLoop.ts", "apps/agent-runtime/src/agents/workers/ReviewerAgent.ts", "apps/agent-runtime/src/schemas/reviewSchema.ts"]
  },
  {
    phase: 3,
    capability: "verification",
    claimed: true,
    status: statuses.partial,
    implemented: "Run-to-green verification states and validation runner exist; package-script smoke ran npm test through Rust.",
    wired: "Run-to-green command result continues after frontend/Rust report-back; static projects show unavailable/not_run.",
    ui: "activity stream can show verification passed/pending",
    cli: "smoke:run-to-green passed",
    provider: "none for run-to-green",
    mocks: "fixture workspaces",
    evidence: ["apps/agent-runtime/src/runtime/RunToGreen.ts", "apps/agent-runtime/src/orchestration/ValidationRunner.ts", "tmp/full-system-audit/command-logs/smoke-run-to-green.log"]
  },
  {
    phase: 3,
    capability: "file locks",
    claimed: true,
    status: statuses.realNotWired,
    implemented: "Orchestration and swarm file lock managers exist.",
    wired: "Swarm scheduler uses lock manager; desktop single-run patch path does not prove lock-aware multi-writer execution.",
    ui: "not visible",
    cli: "swarm scheduler",
    provider: "none",
    mocks: "scheduler workers default mock",
    evidence: ["apps/agent-runtime/src/orchestration/FileLockManager.ts", "apps/agent-runtime/src/orchestration/SwarmScheduler.ts:143"]
  },
  {
    phase: 3,
    capability: "repair loops",
    claimed: true,
    status: statuses.partial,
    implemented: "Run-to-green repair and swarm repair item creation exist.",
    wired: "Run-to-green can select alternate command in tests; swarm repair is scheduler-level with mock workers.",
    ui: "not proven natively",
    cli: "tests/smoke",
    provider: "repair patch may use provider in edit path",
    mocks: "tests use RepairProvider and mock workers",
    evidence: ["apps/agent-runtime/src/runtime/RunToGreen.ts", "apps/agent-runtime/src/orchestration/SwarmScheduler.ts:352", "apps/agent-runtime/src/tests/run-to-green.test.ts"]
  },
  {
    phase: 4,
    capability: "campaigns",
    claimed: true,
    status: statuses.realNotWired,
    implemented: "Campaign CLI/manager exists.",
    wired: "No desktop operator console campaign UX verified.",
    ui: "not visible",
    cli: "campaign scripts exist in package.json",
    provider: "unknown",
    mocks: "likely fixture-driven",
    evidence: ["apps/agent-runtime/src/orchestration/CampaignManager.ts", "apps/agent-runtime/src/orchestration/campaign-cli.ts", "package.json"]
  },
  {
    phase: 4,
    capability: "resumable runs",
    claimed: true,
    status: statuses.partial,
    implemented: "sessions.json snapshots, durable runtime_events replay, and localStorage session restore path exist.",
    wired: "Runtime replay prefers SQLite when present but snapshot fallback still warns not authoritative.",
    ui: "recent session restore path exists; native E2E not verified.",
    cli: "resume-run and agent resume exist",
    provider: "none",
    mocks: "tests",
    evidence: ["apps/agent-runtime/src/runtime/SessionManager.ts:664", "apps/agent-runtime/src/runtime/SessionManager.ts:796", "apps/desktop/src/app/App.tsx:825"]
  },
  {
    phase: 4,
    capability: "execution modes",
    claimed: true,
    status: statuses.partial,
    implemented: "fast/deep/exhaustive and auto mode exist in orchestration/swarm.",
    wired: "Desktop composer has Plan mode, Full Access; no explicit fast/deep/exhaustive UX captured.",
    ui: "startup DOM shows Plan mode and Full Access only.",
    cli: "--mode <auto|fast|deep|exhaustive>",
    provider: "none",
    mocks: "none",
    evidence: ["apps/agent-runtime/src/orchestration/cli.ts:421", "apps/desktop/src/app/App.tsx", "tmp/full-system-audit/screenshots/desktop-vite-dom-snapshot.txt"]
  },
  {
    phase: 4,
    capability: "memory learning",
    claimed: true,
    status: statuses.realNotWired,
    implemented: "decisions/lessons/patterns JSONL and trial tuning records are appended.",
    wired: "Swarm trial writes tuning memory; normal desktop inspect/run does not visibly learn.",
    ui: "not visible",
    cli: "trial commands write memory",
    provider: "none",
    mocks: "trial scenarios mock",
    evidence: ["apps/agent-runtime/src/orchestration/SwarmTrialLab.ts:403", "tmp/full-system-audit/trial-memory/swarm_staffing_lessons.jsonl"]
  },
  {
    phase: 4,
    capability: "metrics/evals foundation",
    claimed: true,
    status: statuses.realNotWired,
    implemented: "Metrics, eval CLI, Phase 4 eval exist.",
    wired: "CLI/test, not desktop.",
    ui: "not visible",
    cli: "eval and trial commands",
    provider: "mostly mock",
    mocks: "yes",
    evidence: ["apps/agent-runtime/src/orchestration/Metrics.ts", "apps/agent-runtime/src/evals/phase4.ts", "apps/agent-runtime/src/evals/cli.ts"]
  },
  {
    phase: 5,
    capability: "internal swarm autopilot",
    claimed: true,
    status: statuses.partial,
    implemented: "SwarmAutopilotRuntime plans/runs and writes artifacts.",
    wired: "CLI only for verified path; not connected to desktop inspect/explain/edit.",
    ui: "not visible",
    cli: "agent plan passed",
    provider: "default worker does not call provider",
    mocks: "defaultMockWorker",
    evidence: ["apps/agent-runtime/src/orchestration/SwarmRuntime.ts:42", "apps/agent-runtime/src/orchestration/SwarmScheduler.ts:49", "tmp/full-system-audit/command-logs/agent-plan.log"]
  },
  {
    phase: 5,
    capability: "automatic StaffingPlan",
    claimed: true,
    status: statuses.realNotWired,
    implemented: "Planner selects counts, risk, specialists, executor caps.",
    wired: "CLI/trials; not desktop normal user path.",
    ui: "not visible",
    cli: "agent plan emitted 9 logical agents",
    provider: "none",
    mocks: "none for plan",
    evidence: ["apps/agent-runtime/src/orchestration/SwarmStaffingPlanner.ts:29", "tmp/full-system-audit/command-logs/agent-plan.log"]
  },
  {
    phase: 5,
    capability: "dynamic specialist agents",
    claimed: true,
    status: statuses.realNotWired,
    implemented: "Specialist descriptors are generated from evidence and marked read_only.",
    wired: "Planner artifacts only; default worker does not instantiate real specialist LLM workers.",
    ui: "not visible",
    cli: "agent plan produced DocumentationReviewerAgent",
    provider: "none",
    mocks: "worker execution mock",
    evidence: ["apps/agent-runtime/src/orchestration/SpecialistAgentFactory.ts:14", "apps/agent-runtime/src/orchestration/SpecialistAgentFactory.ts:128", "tmp/full-system-audit/command-logs/agent-plan.log"]
  },
  {
    phase: 5,
    capability: "logical agents up to 300 when justified",
    claimed: true,
    status: statuses.mock,
    implemented: "Scheduler-scale trial creates 300 logical mock agents and 300 read-only work items.",
    wired: "trial lab only",
    ui: "not visible",
    cli: "scheduler-scale passed",
    provider: "no real model calls",
    mocks: "explicit mock agents",
    evidence: ["apps/agent-runtime/src/orchestration/SwarmTrialLab.ts:180", "apps/agent-runtime/src/orchestration/SwarmTrialLab.ts:194", "tmp/full-system-audit/command-logs/agent-trial-scheduler-scale.log"]
  },
  {
    phase: 5,
    capability: "adaptive scheduler",
    claimed: true,
    status: statuses.partial,
    implemented: "Scheduler leases, traces, executor caps, retries, repair items.",
    wired: "swarm CLI/trial; workers default mock.",
    ui: "not visible",
    cli: "scheduler-scale passed",
    provider: "none by default",
    mocks: "defaultMockWorker",
    evidence: ["apps/agent-runtime/src/orchestration/SwarmScheduler.ts:31", "apps/agent-runtime/src/orchestration/SwarmScheduler.ts:87", "apps/agent-runtime/src/orchestration/SwarmScheduler.ts:506"]
  },
  {
    phase: 5,
    capability: "fan-out/fan-in",
    claimed: true,
    status: statuses.partial,
    implemented: "Work items and agent instances fan out; final report/consensus fan in.",
    wired: "swarm CLI/trial only.",
    ui: "not visible",
    cli: "trial artifacts",
    provider: "none by default",
    mocks: "default workers",
    evidence: ["apps/agent-runtime/src/orchestration/SwarmFanInOut.ts", "apps/agent-runtime/src/orchestration/SwarmRuntime.ts:111"]
  },
  {
    phase: 5,
    capability: "consensus",
    claimed: true,
    status: statuses.mock,
    implemented: "Consensus object is synthesized from review work item statuses.",
    wired: "swarm run artifacts only.",
    ui: "not visible",
    cli: "swarm final report",
    provider: "none",
    mocks: "findings derived from mock work item statuses",
    evidence: ["apps/agent-runtime/src/orchestration/SwarmRuntime.ts:156", "apps/agent-runtime/src/orchestration/SwarmRuntime.ts:175"]
  },
  {
    phase: 5,
    capability: "swarm artifacts/metrics/traces",
    claimed: true,
    status: statuses.realNotWired,
    implemented: "Artifact store persists runs, plans, traces, metrics.",
    wired: "CLI/trial; not UI.",
    ui: "not visible",
    cli: "agent plan/trials",
    provider: "none",
    mocks: "content often mock",
    evidence: ["apps/agent-runtime/src/orchestration/SwarmArtifactStore.ts", "tmp/full-system-audit/trial-memory/swarm_runs"]
  },
  {
    phase: 6,
    capability: "swarm trial lab",
    claimed: true,
    status: statuses.realNotWired,
    implemented: "Trial lab commands ran and wrote reports.",
    wired: "CLI only.",
    ui: "not visible",
    cli: "staffing-eval/scheduler-scale/compare passed",
    provider: "no model calls",
    mocks: "uses mock agents",
    evidence: ["apps/agent-runtime/src/orchestration/SwarmTrialLab.ts:54", "tmp/full-system-audit/command-logs/agent-trial-staffing-eval.log"]
  },
  {
    phase: 6,
    capability: "automatic staffing evals",
    claimed: true,
    status: statuses.mock,
    implemented: "Default scenarios evaluated against planner heuristics.",
    wired: "trial CLI only.",
    ui: "not visible",
    cli: "staffing-eval passed",
    provider: "none",
    mocks: "uses_mock_agents true",
    evidence: ["apps/agent-runtime/src/orchestration/SwarmTrialLab.ts:63", "tmp/full-system-audit/command-logs/agent-trial-staffing-eval.log"]
  },
  {
    phase: 6,
    capability: "scheduler stress tests",
    claimed: true,
    status: statuses.mock,
    implemented: "300 logical read-only work items processed by defaultMockWorker.",
    wired: "trial CLI only.",
    ui: "not visible",
    cli: "scheduler-scale passed",
    provider: "none",
    mocks: "explicit",
    evidence: ["apps/agent-runtime/src/orchestration/SwarmTrialLab.ts:196", "apps/agent-runtime/src/orchestration/SwarmScheduler.ts:506", "tmp/full-system-audit/command-logs/agent-trial-scheduler-scale.log"]
  },
  {
    phase: 6,
    capability: "baseline vs autopilot comparison",
    claimed: true,
    status: statuses.mock,
    implemented: "Comparison command ran, but metrics are heuristic/synthetic in code.",
    wired: "trial CLI only.",
    ui: "not visible",
    cli: "compare passed",
    provider: "none",
    mocks: "synthetic metrics",
    evidence: ["apps/agent-runtime/src/orchestration/SwarmTrialLab.ts:647", "apps/agent-runtime/src/orchestration/SwarmTrialLab.ts:658", "tmp/full-system-audit/command-logs/agent-trial-compare.log"]
  },
  {
    phase: 6,
    capability: "specialist evals",
    claimed: true,
    status: statuses.partial,
    implemented: "Specialist scenarios/triggers exist.",
    wired: "trial/plan only; not real specialist model execution.",
    ui: "not visible",
    cli: "agent plan produced specialist",
    provider: "none",
    mocks: "yes",
    evidence: ["apps/agent-runtime/src/orchestration/SpecialistAgentFactory.ts", "apps/agent-runtime/src/tests/swarm-trial-lab.test.ts"]
  },
  {
    phase: 6,
    capability: "real-world safe trials",
    claimed: true,
    status: statuses.partial,
    implemented: "small-safe-fix trial command exists.",
    wired: "not run in this audit because user forbade fixes/behavior changes.",
    ui: "not visible",
    cli: "available",
    provider: "unknown",
    mocks: "likely mock workers",
    evidence: ["apps/agent-runtime/src/orchestration/cli.ts:259", "apps/agent-runtime/src/orchestration/SwarmTrialLab.ts"]
  },
  {
    phase: 6,
    capability: "tuning feedback loop",
    claimed: true,
    status: statuses.partial,
    implemented: "Trial writes tuning JSONL records with confidence/evidence count.",
    wired: "Trial memory only; defaults not automatically changed.",
    ui: "not visible",
    cli: "trial commands wrote audit memory",
    provider: "none",
    mocks: "yes",
    evidence: ["apps/agent-runtime/src/orchestration/SwarmTrialLab.ts:403", "apps/agent-runtime/src/orchestration/SwarmTrialLab.ts:438", "tmp/full-system-audit/trial-memory/swarm_tuning_history.jsonl"]
  },
  {
    phase: 6,
    capability: "report generation",
    claimed: true,
    status: statuses.realNotWired,
    implemented: "Trial/swarm reports are generated as markdown/json artifacts.",
    wired: "CLI only.",
    ui: "not visible",
    cli: "trial reports",
    provider: "none",
    mocks: "content often based on mock data",
    evidence: ["apps/agent-runtime/src/orchestration/SwarmTrialLab.ts:761", "apps/agent-runtime/src/orchestration/SwarmRuntime.ts:181"]
  },
  {
    phase: 6,
    capability: "trial commands",
    claimed: true,
    status: statuses.realNotWired,
    implemented: "CLI help lists trial commands and package scripts call them.",
    wired: "CLI only, not desktop.",
    ui: "not visible",
    cli: "staffing-eval/scheduler-scale/compare passed",
    provider: "none",
    mocks: "yes",
    evidence: ["apps/agent-runtime/src/orchestration/cli.ts:388", "package.json", "tmp/full-system-audit/command-logs/agent-trial-scheduler-scale.log"]
  },
  {
    phase: "provider",
    capability: "real provider/Ollama support",
    claimed: true,
    status: statuses.partial,
    implemented: "Ollama provider performs real /api/chat calls; direct smoke succeeded.",
    wired: "Desktop can create real_provider sessions when saved provider config is valid.",
    ui: "Provider config exists in DB; active session provider not visible in startup DOM.",
    cli: "real provider smoke script passed on tiny prompt",
    provider: "Ollama qwen2.5-coder:7b success for tiny prompt; inspect prompts timed out.",
    mocks: "default runtime is demo_mock",
    evidence: ["apps/agent-runtime/src/llm/OllamaProvider.ts:45", "apps/agent-runtime/src/config.ts:14", "tmp/full-system-audit/real-provider-smoke.json"]
  },
  {
    phase: "runtime",
    capability: "inspect/explain deep answers",
    claimed: true,
    status: statuses.partial,
    implemented: "Runtime produced Arabic answers with citations and read-lane artifacts.",
    wired: "Desktop submit path can reach this runtime, but native UI was not E2E verified.",
    ui: "not tested through native window",
    cli: "audit script drove AgentRuntime directly",
    provider: "8 prompt calls timed out/aborted; deterministic fallback answered.",
    mocks: "not mock provider, but fallback-heavy",
    evidence: ["apps/agent-runtime/src/runtime/UniversalProjectQuestionEngine.ts:321", "apps/agent-runtime/src/runtime/LlmProjectExplainer.ts:53", "tmp/full-system-audit/answers.json"]
  },
  {
    phase: "desktop",
    capability: "desktop operator console",
    claimed: true,
    status: statuses.partial,
    implemented: "React/Vite UI builds and startup DOM renders; Rust commands exist.",
    wired: "Native Tauri window not automated in audit; Vite web capture is not equivalent.",
    ui: "startup DOM captured; screenshot failed",
    cli: "desktop build passed",
    provider: "settings path in source",
    mocks: "not applicable",
    evidence: ["apps/desktop/src/app/App.tsx", "tmp/full-system-audit/screenshots/desktop-vite-dom-snapshot.txt", "tmp/full-system-audit/screenshots/SCREENSHOT_UNAVAILABLE.md"]
  }
];

const systemInventory = {
  generatedAt: new Date().toISOString(),
  workspace: root,
  fileCounts: {
    rgFilesIncludingAuditTmp: sourceFiles.length,
    rgFilesExcludingAuditTmp: sourceWithoutAuditTmp.length,
    byTopLevel: Object.fromEntries([...byTop.entries()].sort((a, b) => b[1] - a[1]))
  },
  packages: {
    workspaces: packageJson.workspaces ?? [],
    scripts: packageJson.scripts ?? {}
  },
  importantAreas: {
    frontend: ["apps/desktop/src/app/App.tsx", "apps/desktop/src/lib/agentRuntime.ts", "apps/desktop/src/lib/tauri.ts", "apps/desktop/src/app/activityStream.ts"],
    runtime: ["apps/agent-runtime/src/runtime/AgentRuntime.ts", "apps/agent-runtime/src/runtime/RunEngine.ts", "apps/agent-runtime/src/runtime/ProjectIntake.ts", "apps/agent-runtime/src/runtime/UniversalProjectQuestionEngine.ts"],
    rustTauri: ["apps/desktop/src-tauri/src/commands/terminal.rs", "apps/desktop/src-tauri/src/commands/patch.rs", "apps/desktop/src-tauri/src/db/mod.rs", "apps/desktop/src-tauri/src/services/terminal.rs"],
    protocol: ["packages/protocol/src/agent-runtime.ts", "packages/protocol/src/approvals.ts", "packages/protocol/src/models.ts"],
    swarm: ["apps/agent-runtime/src/orchestration/SwarmRuntime.ts", "apps/agent-runtime/src/orchestration/SwarmScheduler.ts", "apps/agent-runtime/src/orchestration/SwarmStaffingPlanner.ts", "apps/agent-runtime/src/orchestration/SwarmTrialLab.ts"],
    memory: [".agent_memory", "apps/agent-runtime/src/memory/RepoIndexer.ts", "apps/agent-runtime/src/memory/CommandInventory.ts"],
    state: [".orchcode-agent-runtime/sessions.json", "C:/Users/A-plus/AppData/Local/OrchCodeStudio/state.sqlite"]
  },
  largeBottlenecks: [
    { path: "apps/desktop/src-tauri/target/debug/deps/orchcode_desktop_lib.lib", bytes: 882170364 },
    { path: "apps/desktop/src-tauri/target/debug/orchcode_desktop_lib.lib", bytes: 876527638 },
    { path: "apps/agent-runtime/.orchcode-agent-runtime/sessions.json", bytes: 68016623 },
    { path: "C:/Users/A-plus/AppData/Local/OrchCodeStudio/state.sqlite", bytes: 838959104 }
  ],
  commandResults
};

const inspectProviderCalls = inspectAnswers.flatMap((entry) => entry.providerCallDetails ?? []);
const inspectChatCalls = inspectProviderCalls.filter((call) => String(call.url ?? "").includes("/api/chat"));
const providerTelemetry = {
  generatedAt: new Date().toISOString(),
  defaults: {
    runtimeConfigDefaultMode: "demo_mock (apps/agent-runtime/src/config.ts:14)",
    healthEndpointReports: "config.defaultMode only, not active session provider (apps/agent-runtime/src/server.ts:35)",
    desktopSavedProvider: sqliteProvider?.providers?.[0] ?? null
  },
  directSmoke: realProviderSmoke,
  inspectExplain: {
    model: "qwen2.5-coder:7b",
    promptCount: inspectAnswers.length,
    chatProviderCalls: inspectChatCalls.length,
    successfulResponses: inspectChatCalls.filter((call) => call.ok).length,
    abortedOrErroredCalls: inspectChatCalls.filter((call) => call.error || call.ok === false).length,
    maxObservedDurationMs: Math.max(0, ...inspectChatCalls.map((call) => call.durationMs ?? 0)),
    conclusion: "The inspect/explain run attempted real Ollama calls, but the chat calls timed out/aborted; final answers came from deterministic fallback/citation logic, not successful model responses."
  },
  proofRule: "Do not claim a model answered unless providerCalls > 0 and response ok=true. Only the tiny direct/runtime smoke has ok=true responses."
};

const realSmokeResults = {
  generatedAt: new Date().toISOString(),
  commands: commandResults,
  runToGreen: {
    status: "passed",
    evidence: "tmp/full-system-audit/command-logs/smoke-run-to-green.log",
    finding: "Package-script workspace requested npm test and smoke reported result back to runtime; static workspace completed with preview/no command."
  },
  terminalAuthority: {
    status: "passed",
    evidence: "tmp/full-system-audit/command-logs/smoke-desktop-run-project.log",
    finding: "Rust classified git status outside repo as not_git_repository and blocked risky git push dry scenario."
  },
  realProvider: providerTelemetry.directSmoke,
  inspectExplain: providerTelemetry.inspectExplain,
  desktopWebDom: {
    status: desktopDomSnapshot ? "DOM loaded" : "not captured",
    screenshotStatus: existsSync(path.join(screenshotDir, "desktop-vite-startup.png")) ? "captured" : "screenshot timed out",
    evidence: ["tmp/full-system-audit/screenshots/desktop-vite-dom-snapshot.txt", "tmp/full-system-audit/screenshots/SCREENSHOT_UNAVAILABLE.md"]
  }
};

function capabilityMarkdownTable(rows) {
  return [
    "| Capability | Claimed | Implemented | Wired | Tested real path | Status | Evidence |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...rows.map((row) => `| ${row.capability} | ${row.claimed ? "yes" : "no"} | ${row.implemented.replaceAll("|", "\\|")} | ${row.wired.replaceAll("|", "\\|")} | ${[row.cli, row.ui, row.provider].filter(Boolean).join("; ").replaceAll("|", "\\|")} | ${row.status} | ${(row.evidence ?? []).join("<br>").replaceAll("|", "\\|")} |`)
  ].join("\n");
}

const architectureMap = `# Architecture Map

## High-Level Packages
- \`apps/agent-runtime\`: Node/Fastify runtime, session manager, RunEngine, inspect/explain analyzers, provider adapters, memory CLI, orchestration/swarm CLI.
- \`apps/desktop\`: React/Vite desktop UI. The captured web DOM renders startup controls, but native Tauri behavior was not automated.
- \`apps/desktop/src-tauri\`: Rust authority for workspace selection, command execution, patch apply, provider validation, SQLite state.
- \`packages/protocol\`: shared TypeScript models for runtime sessions, approvals, provider config, commands, patches.
- \`docs\`: architecture/phase/operator documentation. Treated as claims, not truth.
- \`scripts\`: launch/smoke helpers.
- \`.agent_memory\`: committed/local memory, repo index, command inventory, swarm trials/runs.
- \`.orchcode-agent-runtime\`: Node runtime snapshot store; current root sessions.json is empty, but apps/agent-runtime/.orchcode-agent-runtime/sessions.json is 68 MB.
- \`C:/Users/A-plus/AppData/Local/OrchCodeStudio/state.sqlite\`: desktop SQLite state, 839 MB, 95 sessions, 6274 session_events.

## Runtime Responsibility Map
- Planning: \`RunEngine\` for normal desktop sessions; \`CoreOrchestrator\` and \`SwarmAutopilotRuntime\` for CLI/orchestrated paths.
- Inspect/explain: \`RunEngine.runInspectExplainTurn\` -> \`UniversalProjectQuestionEngine\` -> read lanes/facts/evidence -> \`LlmProjectExplainer\`/fallback.
- Run-to-green: deterministic \`RunEngine\` path; startup command inference bypasses brittle provider planning.
- Command requests: runtime creates command requests; frontend/Rust executes and reports back.
- Patch proposals: provider/runtime proposes; frontend approves/applies; Rust applies; frontend reports result back.
- Session manager: \`SessionManager\` stores snapshots and tokens in \`sessions.json\`.
- Event log/replay: Rust SQLite \`runtime_events\`; runtime can replay via \`DurableRuntimeEvents\` but still falls back to snapshots.
- Swarm runtime: \`SwarmAutopilotRuntime\`, \`SwarmStaffingPlanner\`, \`SwarmScheduler\`, \`SwarmArtifactStore\`.
- Memory/indexing: \`RepoIndexer\`, \`CommandInventory\`, memory CLIs.

## Desktop Responsibility Map
- UI state: \`apps/desktop/src/app/App.tsx\` owns workspace, runtime session, provider config, access profile, panels.
- SSE subscription: \`subscribeRuntimeEvents\` in \`lib/agentRuntime.ts\`; \`App.tsx\` mirrors events into Rust SQLite.
- Command approval/execution: frontend effect can auto-run via \`terminalOrchestrator.ts\`; Rust \`execute_approved_command\` is authority.
- Patch bridge: frontend calls Rust \`apply_runtime_patch\`, then reports result to runtime.
- Workspace selection: Rust commands canonicalize/guard workspace; frontend caches recent workspaces in localStorage.
- LocalStorage: recent sessions/tokens/workspaces/sidebar/RTL/full-access banner.
- Tauri calls: \`lib/tauri.ts\` wraps invoke commands.

## Rust/Tauri Responsibility Map
- Command execution: \`commands/terminal.rs\`, \`services/terminal.rs\`.
- Command policy: \`services/command_policy.rs\`.
- Patch apply: \`commands/patch.rs\` and patch services.
- Git snapshots: patch apply captures snapshots/reconciliation evidence when possible.
- DB persistence/projections: \`db/mod.rs\` tables for sessions/events/commands/artifacts/provider config.
- Workspace guards: terminal service canonicalizes cwd/workspace and rejects cwd outside workspace.

## Suspicious Parallel Implementations
- Command policy exists in both \`apps/agent-runtime/src/tools/CommandPolicy.ts\` and Rust \`services/command_policy.rs\`.
- File lock managers exist in \`src/orchestration/FileLockManager.ts\` and \`src/scheduler/FileLockManager.ts\`.
- Session truth is split across Node \`sessions.json\`, Rust SQLite \`session_events/runtime_events\`, and frontend localStorage.
- Provider config shape differs at the edge: protocol uses \`providerType\`; an audit using \`type\` failed with "Unsupported provider type: undefined", showing the path is brittle outside the UI wrapper.
`;

const fileInventory = `# File Inventory

- \`rg --files\` after audit artifacts: ${sourceFiles.length}.
- \`rg --files\` excluding \`tmp/\`: ${sourceWithoutAuditTmp.length}.
- Top-level source counts after audit: ${[...byTop.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(", ")}.
- Filesystem excluding \`node_modules/.git\` is much larger because Rust target/build outputs are present: 16,684 files observed.

## Important Areas
- Frontend: \`apps/desktop/src/app/App.tsx\`, \`apps/desktop/src/lib/agentRuntime.ts\`, \`apps/desktop/src/lib/tauri.ts\`, \`apps/desktop/src/app/activityStream.ts\`.
- Runtime: \`apps/agent-runtime/src/runtime/*.ts\`, especially \`AgentRuntime.ts\`, \`RunEngine.ts\`, \`ProjectIntake.ts\`, \`UniversalProjectQuestionEngine.ts\`.
- Providers: \`apps/agent-runtime/src/llm/OllamaProvider.ts\`, \`OpenAIProvider.ts\`, \`MockLlmProvider.ts\`.
- Rust/Tauri: \`apps/desktop/src-tauri/src/commands\`, \`services\`, \`db/mod.rs\`.
- Protocol: \`packages/protocol/src/agent-runtime.ts\`, \`approvals.ts\`, \`models.ts\`.
- Swarm: \`apps/agent-runtime/src/orchestration/Swarm*.ts\`, \`SpecialistAgentFactory.ts\`.
- Tests: \`apps/agent-runtime/src/tests\`, \`apps/desktop/src-tauri/src/db/mod.rs\` embedded tests, Rust command tests.

## Large Bottlenecks / State Growth
- Rust target artifacts dominate disk and filesystem traversal. Largest observed file: \`apps/desktop/src-tauri/target/debug/deps/orchcode_desktop_lib.lib\` at 882 MB.
- Desktop SQLite state is \`C:/Users/A-plus/AppData/Local/OrchCodeStudio/state.sqlite\` at 839 MB.
- \`apps/agent-runtime/.orchcode-agent-runtime/sessions.json\` is 68 MB.
- Old \`tmp/root-cause-audit\` artifacts polluted inspect/explain evidence, including DBSCAN answers.

## Old Phase / Generated Remnants
- \`tmp/root-cause-audit\`, \`.agent_memory/swarm_trials\`, \`.agent_memory/swarm_runs\`, \`.tmp-run\`, and multiple \`.orchcode-*.log\` files are active risk for false grounding if runtime scans generated output as project source.
`;

const runtimeFlowMap = `# Runtime Flow Map

## Run This Project
\`\`\`
UI submit
  -> App.tsx createRuntimeRun() in Rust for token/session shell
  -> createRuntimeSession() HTTP to Node runtime
  -> AgentRuntime.runTurn()
  -> RunEngine project intake
  -> deterministic run_to_green command inference
  -> runtime command request
  -> frontend auto-run/approval effect
  -> Rust execute_approved_command()
  -> Rust persists command event/result
  -> Rust posts runtime command result back to Node
  -> runtime updates run_to_green/verification
  -> SSE/front-end state update
\`\`\`

Evidence: \`App.tsx:848\`, \`RunEngine.ts:238\`, \`terminalOrchestrator.ts:20\`, \`terminal.rs:33\`, smoke logs. Status: Partial. The split frontend/Rust report-back is real risk.

## Inspect/Explain
\`\`\`
UI submit
  -> AgentRuntime.runTurn()
  -> RunEngine.runInspectExplainTurn()
  -> ProjectIntake + context_pack
  -> UniversalProjectQuestionEngine
  -> read lanes / evidence tiers / mechanism chain
  -> LlmProjectExplainer provider call
  -> validation/fallback
  -> assistant answer + artifacts
\`\`\`

Evidence: \`RunEngine.ts:885\`, \`UniversalProjectQuestionEngine.ts:321\`, \`LlmProjectExplainer.ts:53\`, \`answers.json\`. Status: Partial. Audit prompts attempted real provider calls but timed out; deterministic fallback answered and sometimes used stale \`tmp/\` artifacts.

## User Approves Command
\`\`\`
runtime.command.requested
  -> frontend command approval or full-access auto-run
  -> Rust execute_approved_command
  -> SQLite session_events/runtime_events
  -> post_runtime_command_result back to Node runtime
  -> Node marks command completed/failed
\`\`\`

Evidence: \`terminal.rs:33\`, \`terminal.rs:135\`, \`App.tsx:482\`. Status: Real and wired for smoke, but split handoff can fail after command execution.

## Patch Apply
\`\`\`
runtime patch proposal
  -> frontend approval/auto-apply effect
  -> Rust apply_runtime_patch loads proposal from SQLite session_events
  -> path guard + apply + git snapshot/reconciliation event
  -> frontend reportRuntimePatchApplyResult()
  -> runtime marks patch applied/rejected/failed
\`\`\`

Evidence: \`patch.rs:28\`, \`App.tsx:517\`. Status: Partial. Rust applies, but runtime reconciliation still depends on frontend report-back.

## Swarm Run
\`\`\`
agent run/plan CLI
  -> SwarmAutopilotRuntime
  -> load/rebuild memory index
  -> SwarmStaffingPlanner
  -> create templates/instances/work items
  -> SwarmScheduler
  -> defaultMockWorker unless custom worker injected
  -> artifact/metrics/report/consensus
\`\`\`

Evidence: \`SwarmRuntime.ts:62\`, \`SwarmScheduler.ts:49\`, \`SwarmScheduler.ts:506\`, \`agent-plan.log\`. Status: Partial/mock-heavy.

## Restore
\`\`\`
Runtime startup
  -> SessionManager loads sessions.json
  -> tries durable SQLite runtime_events
  -> replays if sufficient
  -> otherwise snapshot fallback with warning
Frontend
  -> localStorage recent session/token
  -> subscribe/get runtime session
  -> fallback to Rust saved snapshot if token/runtime unavailable
\`\`\`

Evidence: \`SessionManager.ts:664\`, \`SessionManager.ts:796\`, \`App.tsx:825\`. Status: Partial.
`;

const uiFlowMap = `# UI Flow Map

## Verified
- Vite web UI rendered at \`http://127.0.0.1:5174/\`.
- DOM showed: Select workspace, details/diff/terminal toggles, composer, Plan mode, RTL, Full Access, Open workspace, startup suggestions.
- Console errors/warnings from browser capture: 0.
- Screenshot capture through in-app browser timed out; see \`screenshots/SCREENSHOT_UNAVAILABLE.md\`.

## Not Verified
- Native Tauri window automation was not performed.
- Native file picker/workspace activation was not clicked.
- Real runtime SSE update into native UI was not E2E verified.
- Command approval and patch auto-apply were verified by source and smoke scripts, not by clicking in the native window.

## Source Trace Findings
- UI state lives mostly in \`App.tsx\`.
- Runtime session subscription mirrors events to Rust SQLite asynchronously. If append fails, UI logs but runtime keeps moving.
- Activity stream is a derived compact stream from recent transitions, not a full event log by default.
- Terminal drawer can run manual Rust commands separately from agent command requests.
- Full Access defaults are visible in startup DOM, but dangerous command behavior still depends on frontend safety settings and Rust policy.
- Provider mode is configured in settings/source/DB, but startup DOM did not clearly show "active provider/model".
- Swarm/trial artifacts are not visible in captured startup DOM.

## Evidence
- \`tmp/full-system-audit/screenshots/desktop-vite-dom-snapshot.txt\`
- \`apps/desktop/src/app/App.tsx:482\`, \`App.tsx:761\`, \`App.tsx:848\`
- \`apps/desktop/src/app/activityStream.ts\`
`;

const databaseStateMap = `# Database / Persistence / State Map

## SQLite
- Path: \`${sqliteState?.dbPath ?? "C:/Users/A-plus/AppData/Local/OrchCodeStudio/state.sqlite"}\`.
- Size observed: 838,959,104 bytes.
- Tables: ${(sqliteState?.tables ?? []).join(", ")}.
- Counts: \`${JSON.stringify(sqliteState?.counts ?? {})}\`.
- Saved provider config: \`${JSON.stringify(sqliteProvider?.providers?.[0] ?? null)}\`.
- Recent sessions in SQLite are mostly \`status=created\` while session_events contain many runtime updates. That is a source-of-truth smell.

## Node Runtime Snapshot
- Default root storage: \`.orchcode-agent-runtime/sessions.json\`; current root file contains empty sessions.
- Secondary observed storage: \`apps/agent-runtime/.orchcode-agent-runtime/sessions.json\`, 68 MB.
- SessionManager still warns snapshot restore is not event-replay authoritative.

## Frontend LocalStorage
- Source stores recent workspaces/sessions/tokens/sidebar/RTL/full-access notice in localStorage. Not directly inspectable from native app in this audit.

## Memory State
- \`.agent_memory\` contains committed memory files plus many swarm run/trial artifacts.
- Audit-local trial memory under \`tmp/full-system-audit/trial-memory\` was created for non-destructive trial commands.

## Source-of-Truth Diagram
\`\`\`
Live UI state
  -> runtime HTTP/SSE session snapshot
  -> async mirror to Rust session_events
  -> derived runtime_events in SQLite
  -> Node sessions.json snapshot
  -> frontend localStorage recent session/token
\`\`\`

Verdict: persistence is real but duplicated. Replay exists, but the product still uses snapshot/localStorage fallbacks and split session ids/tokens.
`;

const agentSwarmAudit = `# Agent / Swarm Audit

## Reality
- Multi-agent swarm is a real scheduler/artifact/planner subsystem.
- Default workers are mock/logical. \`SwarmScheduler\` constructor defaults to \`defaultMockWorker\`.
- A 300-agent trial means 300 logical scheduler entries, not 300 model calls or OS workers.
- Specialist agents are descriptors and role counts unless a real worker is injected.
- Consensus is synthesized from review work-item statuses, not an independent deliberation among provider-backed agents.
- Swarm is not connected to the main desktop inspect/explain path.

## Commands Run
- \`agent trial staffing-eval\`: passed; 10 scenarios; uses mock agents.
- \`agent trial scheduler-scale\`: passed; 300 logical agents; executor peak 0; mock read-only work.
- \`agent trial compare\`: passed; comparison metrics are heuristic/synthetic.
- \`agent plan "Explain architecture without editing"\`: passed; produced 9 logical agents and one DocumentationReviewerAgent descriptor.

## Useful Today?
Useful for planning artifacts, repo-scale heuristic scans, and exercising scheduler constraints. Not useful as real provider-backed multi-agent understanding in the desktop product today.

## Real-vs-Mock Worker Matrix
| Worker/role | Real file reads | Provider-backed | Writes | Main UI path | Status |
| --- | --- | --- | --- | --- | --- |
| Scout/Planner/Reviewer in swarm scheduler | Through work item metadata/index, not active deep read by default worker | No | No | No | Mock/test-only |
| Specialist descriptors | Triggered from goal/file evidence | No | No, read_only=true | No | Real but not wired to main path |
| RunEngine inspect/explain read lanes | Yes | Attempts provider, fallback deterministic | No | Yes through runtime submit | Partial |
| Rust command executor | Yes, executes commands | No | Command side effects | Yes | Real and wired |
`;

const finalReport = `# Full System Reality Audit For OrchCode Studio

## A. Executive Verdict
**Strong infrastructure, weak product loop**

## B. One-Paragraph Truth
OrchCode Studio is not an empty shell: it has a real Node runtime, a real React/Tauri desktop shell, real Rust command and patch authority, real SQLite persistence, real memory/indexing tools, a serious inspect/explain evidence engine, and a substantial swarm/trial artifact system. But the things that make it feel like a working local coding agent are still fractured: the default runtime is mock, health does not show active provider truth, real-provider inspect calls timed out and fell back, memory/swarm are mostly CLI-side rather than normal UI path, command and patch completion depend on frontend report-back bridges, generated \`tmp/\` artifacts contaminate reasoning, and the UI exposes only a compact slice of what the runtime knows.

## C. What Exists And Is Real

### Runtime
- Real Fastify runtime endpoints for sessions, turns, SSE, command results, patch results: \`apps/agent-runtime/src/server.ts\`.
- Real session manager with tokens/snapshots/replay attempt: \`SessionManager.ts\`.
- Real run-to-green deterministic workflow with command requests and verification state: \`RunEngine.ts\`, \`RunToGreen.ts\`.
- Real inspect/explain analyzers and evidence artifacts: \`UniversalProjectQuestionEngine.ts\`, \`InspectExplainReadLanes.ts\`, \`ProjectIntelligenceKernel.ts\`.

### UI
- React UI builds and Vite startup DOM renders. Verified DOM: \`screenshots/desktop-vite-dom-snapshot.txt\`.
- UI has workspace picker, composer, panels, Full Access, terminal drawer, settings, details/diff toggles.
- Native Tauri window E2E was not automated.

### Rust
- Real command execution and policy through Rust.
- Real SQLite persistence and provider validation.
- Real patch apply bridge with workspace path guards and git snapshot hooks.

### Memory
- Memory/index/command inventory exists and commands pass.
- It is not the normal desktop inspect/run source of truth.

### Swarm
- Staffing planner, scheduler, artifact store, trial lab, traces, metrics exist.
- Workers are mock/logical by default.

### Inspect/Explain
- Real runtime path produced answers for all requested Arabic prompts.
- Provider calls were attempted but timed out/aborted; answers came from deterministic fallback/citation logic.
- Evidence contamination was observed: DBSCAN answer used \`tmp/root-cause-audit/explain-repro-results.json\` as proof.

### Terminal
- Rust command authority works in smoke: safe git status, non-git diagnosis, package \`npm test\`, risky git push blocked.
- Terminal drawer is separate from agent command execution.

### Persistence
- SQLite state exists and is large: 839 MB, 95 sessions, 6274 session_events.
- Node snapshots exist; replay still falls back to snapshots.

### Tests
- \`npm test\` passed 209 Node tests.
- \`cargo test\` passed 21 Rust tests.
- These mostly prove units, mocks, temp workspaces, and smoke harnesses, not native UI product behavior.

## D. What Is Only Mock/Test/Docs
- 300 logical agents: mock scheduler stress, not 300 real LLM calls.
- Swarm default workers: \`defaultMockWorker\`.
- Consensus: synthesized from work item status.
- Trial compare metrics: heuristic/synthetic.
- Many Phase 5/6 claims are real artifacts but mock execution.
- Passing inspect tests do not prove real user answers; audit prompts showed provider timeout and fallback.

## E. What Is Wired To The User Path
- Desktop submit -> runtime session -> RunEngine.
- Inspect/explain path through RunEngine.
- Run-to-green command requests through frontend/Rust/report-back.
- Full Access auto-run settings in frontend and protocol defaults.
- Rust terminal/patch authority.
- SSE session updates and compact UI activity stream.

## F. What Is Not Wired To The User Path
- Swarm autopilot/trial lab in normal desktop UI.
- Repo memory/index freshness in normal desktop composer flow.
- Campaign management in desktop.
- Trial reports and swarm artifacts in UI.
- Provider call telemetry in runtime/session artifacts.
- Full event log as primary UI stream.
- Native UI E2E proof in this audit.

## G. Top 10 Root Causes Of "It Still Does Not Work"
1. Provider truth is muddy: default runtime is \`demo_mock\`, desktop may create \`real_provider\`, health only reports config default.
2. Real provider is not reliable enough in deep inspect: audit prompt calls timed out after about 60s and fallback answered.
3. Generated \`tmp/\` artifacts are scanned as project evidence, causing false confidence.
4. Swarm is impressive infrastructure but not connected to the desktop product loop.
5. Command and patch flows are split: Rust acts, frontend must report back to runtime.
6. Persistence has too many truths: SQLite, session_events, runtime_events, sessions.json, localStorage.
7. UI shows a compact derived activity stream, not the authoritative event/reasoning stream.
8. Memory/index exists but normal runtime uses live scans/context packs instead.
9. Tests are green but mostly mock/unit/smoke, not native UI + real provider + Rust authority together.
10. Provider telemetry is absent, so users cannot tell whether Ollama/GPU/model actually answered.

## H. Capability Matrix
${capabilityMarkdownTable(capabilityMatrix)}

## I. Flow Diagrams

### Run This Project
\`\`\`
UI -> create Rust run/token -> create Node runtime session -> RunEngine intake
   -> deterministic run_to_green command -> command request
   -> frontend auto/manual approval -> Rust execute
   -> SQLite event/result -> HTTP report-back -> runtime verification -> SSE/UI
\`\`\`

### Inspect/Explain
\`\`\`
UI -> runtime session -> RunEngine inspect/explain
   -> project intake/context_pack -> read lanes/evidence tiers
   -> provider call -> timeout/fallback if needed -> validated answer -> UI
\`\`\`

### Terminal Command
\`\`\`
Manual drawer: UI -> Rust run_workspace_command -> terminal result only
Agent command: runtime request -> UI approval/auto-run -> Rust execute_approved_command -> report back to runtime
\`\`\`

### Patch Apply
\`\`\`
runtime proposal -> UI approval/auto-apply -> Rust apply_runtime_patch
   -> git snapshot/reconcile -> UI reportRuntimePatchApplyResult -> runtime state
\`\`\`

### Swarm Run
\`\`\`
CLI agent run/plan -> memory rebuild -> staffing planner -> scheduler
   -> defaultMockWorker -> artifacts/metrics/consensus/report
\`\`\`

### Restore
\`\`\`
localStorage recent session/token + runtime sessions.json + Rust SQLite events
   -> replay if possible -> snapshot fallback with warning
\`\`\`

## J. Test / Reality Gap
- \`npm test\`: passed 209 tests, but uses mock providers, deterministic providers, and fixture workspaces.
- \`cargo test\`: passed, but native UI was not driven.
- Smoke scripts prove important slices, especially Rust command authority, but not the whole desktop user experience.
- Real provider smoke proves Ollama can answer tiny prompts; it does not prove deep inspect works with Ollama.
- Inspect/explain audit proves the fallback can answer with citations, but also proves provider timeout and stale/generated evidence contamination.

## K. Screenshots And Smoke Evidence
- Web UI DOM capture: \`tmp/full-system-audit/screenshots/desktop-vite-dom-snapshot.txt\`.
- Screenshot image: unavailable; in-app browser \`Page.captureScreenshot\` timed out. See \`screenshots/SCREENSHOT_UNAVAILABLE.md\`.
- Native Tauri screenshot/E2E: not automated.
- Command logs: \`tmp/full-system-audit/command-logs/\`.
- Real provider smoke: \`tmp/full-system-audit/real-provider-smoke.json\`.
- Inspect answers: \`tmp/full-system-audit/answers.json\`.

## L. Immediate Fix Shortlist
1. Add first-class provider telemetry to sessions: mode, model, request count, response count, timeout/error/fallback, latency.
2. Exclude generated audit/run/tmp artifacts from project evidence by default, or mark them as generated/evidence-tier low.
3. Collapse command/patch report-back into a single reliable Rust-owned transaction or runtime bridge helper.
4. Wire memory freshness/index and inspect evidence files into the desktop operator console.
5. Make inspect/explain use targeted deep investigation before LLM, with visible evidence and a hard no-answer state when proof is weak.

## M. What To Stop Doing
- Stop treating mock trial success as product multi-agent success.
- Stop patching prompt aliases while stale/generated evidence is still admitted as proof.
- Stop adding mock-only tests for UI/runtime/provider claims without a real-path smoke.
- Stop expanding swarm agent counts before the desktop product loop is wired.
- Stop relying on health/default mode as provider truth.

## N. Recommended Next Implementation Prompt
Implement provider and evidence truth telemetry for the normal desktop inspect/explain path only. Add session fields and UI display for provider mode, model, provider request count, successful response count, timeout/error count, fallbackUsed, and the top evidence files actually used. Exclude \`tmp/\`, \`.agent_memory/swarm_runs\`, \`.agent_memory/swarm_trials\`, build outputs, and runtime snapshot directories from inspect/explain source evidence unless the user explicitly asks to inspect generated artifacts. Add one real runtime smoke that asks an inspect/explain question and asserts: provider telemetry is present, generated artifacts are excluded, and the UI/session artifact names the evidence files.

## O. Appendix

### Commands Run
${commandResults.map((entry) => `- ${entry.command}: ${entry.status}; log ${entry.log}`).join("\n")}

### Environment Notes
- Workspace: \`${root}\`
- Date: ${new Date().toISOString()}
- Ollama tags available during audit: ${(realProviderSmoke.availableModels ?? []).join(", ")}
- Saved desktop provider in SQLite: \`${JSON.stringify(sqliteProvider?.providers?.[0] ?? null)}\`
- Dev web UI server was started for DOM capture on \`http://127.0.0.1:5174/\` and stopped after audit.

### Known Audit Limitations
- No native Tauri window automation.
- Screenshot capture timed out, but DOM and logs were captured.
- Inspect/explain audit disabled audit-script session snapshot persistence to avoid huge JSON write failures; runtime logic still ran in memory.
- Some command logs include Windows/PowerShell encoding artifacts; UTF-8 files are readable with explicit UTF-8.
`;

writeFileSync(path.join(auditDir, "system-inventory.json"), `${JSON.stringify(systemInventory, null, 2)}\n`);
writeFileSync(path.join(auditDir, "capability-matrix.json"), `${JSON.stringify(capabilityMatrix, null, 2)}\n`);
writeFileSync(path.join(auditDir, "provider-telemetry-report.json"), `${JSON.stringify(providerTelemetry, null, 2)}\n`);
writeFileSync(path.join(auditDir, "real-smoke-results.json"), `${JSON.stringify(realSmokeResults, null, 2)}\n`);
writeFileSync(path.join(auditDir, "architecture-map.md"), architectureMap);
writeFileSync(path.join(auditDir, "file-inventory.md"), fileInventory);
writeFileSync(path.join(auditDir, "runtime-flow-map.md"), runtimeFlowMap);
writeFileSync(path.join(auditDir, "ui-flow-map.md"), uiFlowMap);
writeFileSync(path.join(auditDir, "database-state-map.md"), databaseStateMap);
writeFileSync(path.join(auditDir, "agent-swarm-audit.md"), agentSwarmAudit);
writeFileSync(path.join(auditDir, "final-report.md"), finalReport);

console.log(JSON.stringify({
  ok: true,
  artifacts: [
    "system-inventory.json",
    "capability-matrix.json",
    "architecture-map.md",
    "file-inventory.md",
    "runtime-flow-map.md",
    "ui-flow-map.md",
    "database-state-map.md",
    "agent-swarm-audit.md",
    "provider-telemetry-report.json",
    "real-smoke-results.json",
    "final-report.md"
  ].map((file) => path.join(auditDir, file))
}, null, 2));
