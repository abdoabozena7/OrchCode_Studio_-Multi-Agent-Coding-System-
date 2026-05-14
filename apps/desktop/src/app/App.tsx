import {
  Bot,
  ChevronDown,
  Code2,
  Copy,
  Diff,
  FileText,
  FolderOpen,
  GitBranch,
  Globe,
  MessageSquarePlus,
  PanelLeft,
  Play,
  RefreshCw,
  Settings,
  ShieldCheck,
  TerminalSquare,
  ToggleLeft,
  ToggleRight,
  Trash2,
  Workflow,
  X
} from "lucide-react";
import type {
  AccessProfile,
  AgentRun,
  AppEvent,
  AgentRuntimeSession,
  AgentWorkStatus,
  CommandRequest,
  CommandResult,
  DecisionRecord,
  EvidenceRef,
  FileEntry,
  GitStatus,
  ModelInfo,
  ModelProviderConfig,
  ModelProviderType,
  PatchChangeStats,
  RunMode,
  RunPhase,
  SafetySettings,
  WorkspaceInfo
} from "@orchcode/protocol";
import { accessProfileDefaults, defaultSafetySettings } from "@orchcode/protocol";
import { useEffect, useRef, useState } from "react";
import {
  approveRuntimePatch,
  createRuntimeSession,
  getRuntimeSession,
  rejectRuntimePatch,
  reportRuntimeCommandResult,
  reportRuntimePatchApplyResult,
  runRuntimeTurn,
  subscribeRuntimeEvents
} from "../lib/agentRuntime";
import {
  clearModelProviderConfig,
  appendSessionEvent,
  applyRuntimePatch,
  createRuntimeRun,
  getGitDiff,
  getGitStatus,
  getModelProviderConfig,
  listAvailableModels,
  listWorkspaceFiles,
  openWorkspace,
  openExternalTarget,
  pickWorkspaceDirectory,
  executeApprovedCommand,
  runWorkspaceCommand,
  upsertAgentRun,
  upsertOrchestrationRun,
  saveModelProviderConfig,
  validateModelProvider,
  type ModelProviderConfigInput
} from "../lib/tauri";

type ProviderPreset = {
  label: string;
  providerType: ModelProviderType;
  providerName: string;
  baseUrl: string;
};

type AccessOption = {
  value: AccessProfile;
  label: string;
  description: string;
};

type QueuedPrompt = {
  id: string;
  text: string;
  mode: "queued" | "steer";
};

type BottomView = "none" | "terminal" | "diff";

type RecentWorkspaceEntry = {
  path: string;
  name: string;
  lastOpenedAt: string;
  lastSessionId?: string;
};

type RecentSessionEntry = {
  id: string;
  workspacePath: string;
  workspaceName: string;
  title: string;
  status: string;
  updatedAt: string;
};

const RECENT_WORKSPACES_KEY = "orchcode.recentWorkspaces";
const RECENT_SESSIONS_KEY = "orchcode.recentSessions";
const LAST_WORKSPACE_KEY = "orchcode.lastWorkspace";
const PROMPT_HISTORY_KEY = "orchcode.promptHistory";
const MAX_RECENT_WORKSPACES = 8;
const MAX_RECENT_SESSIONS = 12;
const MAX_PROMPT_HISTORY = 50;

const providerPresets: ProviderPreset[] = [
  {
    label: "Ollama",
    providerType: "ollama",
    providerName: "Ollama",
    baseUrl: "http://localhost:11434"
  },
  {
    label: "OpenAI-compatible custom API",
    providerType: "openai_compatible",
    providerName: "OpenAI-compatible custom API",
    baseUrl: "https://api.openai.com"
  },
  {
    label: "OpenRouter-compatible custom API",
    providerType: "openai_compatible",
    providerName: "OpenRouter",
    baseUrl: "https://openrouter.ai/api"
  },
  {
    label: "Local/private OpenAI-compatible server",
    providerType: "openai_compatible",
    providerName: "Private OpenAI-compatible server",
    baseUrl: "http://localhost:8000"
  }
];

const defaultProviderForm: ModelProviderConfigInput = {
  id: "default",
  providerType: "ollama",
  providerName: "Ollama",
  baseUrl: "http://localhost:11434",
  selectedModel: "",
  apiKey: ""
};

const starterPrompts = [
  "Explain this project to me",
  "Analyze the workspace and suggest the safest first change"
];

const accessOptions: AccessOption[] = [
  {
    value: "default_permissions",
    label: "Default permissions",
    description: "Review patches and run safe commands manually."
  },
  {
    value: "auto_review",
    label: "Auto-review",
    description: "Auto-run safe validation, but still stop before opening previews."
  },
  {
    value: "bounded_autonomy",
    label: "Bounded autonomy",
    description: "Auto-run safe validation, but patch apply and command execution still depend on explicit Rust authority."
  },
  {
    value: "custom_config",
    label: "Custom (config.toml)",
    description: "Advanced custom policy surface reserved for later."
  }
];

export function App() {
  const workspaceInputRef = useRef<HTMLInputElement | null>(null);
  const queueIdRef = useRef(0);
  const runtimeEventUnsubscribeRef = useRef<(() => void) | null>(null);
  const lastCommandCountRef = useRef(0);
  const lastPreviewTargetRef = useRef("");
  const suppressPreviewOpenRef = useRef(false);
  const [workspacePath, setWorkspacePath] = useState("");
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);
  const [diffText, setDiffText] = useState("");
  const [terminalCommand, setTerminalCommand] = useState("git status");
  const [terminalResult, setTerminalResult] = useState<CommandResult | null>(null);
  const [prompt, setPrompt] = useState("");
  const [runtimeSession, setRuntimeSession] = useState<AgentRuntimeSession | null>(null);
  const [runtimeSessionToken, setRuntimeSessionToken] = useState("");
  const [thinkFirst, setThinkFirst] = useState(false);
  const [accessProfile, setAccessProfile] = useState<AccessProfile>("default_permissions");
  const [accessMenuOpen, setAccessMenuOpen] = useState(false);
  const [safetySettings, setSafetySettings] = useState<SafetySettings>({
    ...defaultSafetySettings,
    ...accessProfileDefaults("default_permissions")
  });
  const [providerConfig, setProviderConfig] = useState<ModelProviderConfig | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [message, setMessage] = useState("Select a workspace and start from the composer.");
  const [agentBusy, setAgentBusy] = useState(false);
  const [queuedPrompts, setQueuedPrompts] = useState<QueuedPrompt[]>([]);
  const [activityOpen, setActivityOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [bottomView, setBottomView] = useState<BottomView>("none");
  const [recentWorkspaces, setRecentWorkspaces] = useState<RecentWorkspaceEntry[]>([]);
  const [recentSessions, setRecentSessions] = useState<RecentSessionEntry[]>([]);
  const [promptHistory, setPromptHistory] = useState<string[]>([]);
  const [promptHistoryIndex, setPromptHistoryIndex] = useState<number | null>(null);
  const [promptDraftBeforeHistory, setPromptDraftBeforeHistory] = useState("");
  const [runtimeConnectionState, setRuntimeConnectionState] = useState<"connected" | "disconnected">("connected");

  useEffect(() => {
    void (async () => {
      try {
        setProviderConfig(await getModelProviderConfig());
      } catch {
        setProviderConfig(null);
      }
      const storedWorkspaces = readStoredJson<RecentWorkspaceEntry[]>(RECENT_WORKSPACES_KEY, []);
      const storedSessions = readStoredJson<RecentSessionEntry[]>(RECENT_SESSIONS_KEY, []);
      const storedPromptHistory = readStoredJson<string[]>(PROMPT_HISTORY_KEY, []);
      setRecentWorkspaces(storedWorkspaces.map((entry) => ({ ...entry, path: normalizeWorkspacePath(entry.path) })));
      setRecentSessions(storedSessions);
      setPromptHistory(storedPromptHistory);
      const lastWorkspacePath = localStorage.getItem(LAST_WORKSPACE_KEY);
      if (lastWorkspacePath) {
        setWorkspacePath(normalizeWorkspacePath(lastWorkspacePath));
      }
    })();
    return () => runtimeEventUnsubscribeRef.current?.();
  }, []);

  useEffect(() => {
    setSafetySettings((current) => ({
      ...accessProfileDefaults(accessProfile),
      maxParallelAgents: current.maxParallelAgents
    }));
  }, [accessProfile]);

  useEffect(() => {
    if (agentBusy || queuedPrompts.length === 0) return;
    const [next, ...rest] = queuedPrompts;
    if (!next) return;
    setQueuedPrompts(rest);
    void submitPrompt(next.text, next.mode);
  }, [agentBusy, queuedPrompts]);

  useEffect(() => {
    if (!runtimeSession) {
      lastCommandCountRef.current = 0;
      return;
    }
    const count = runtimeSession.commandExecutions.length;
    if (count > lastCommandCountRef.current) {
      const latestExecution = runtimeSession.commandExecutions.at(-1);
      if (latestExecution) {
        setTerminalCommand(latestExecution.command);
        setTerminalResult({
          command: latestExecution.command,
          cwd: latestExecution.cwd,
          risk: latestExecution.risk,
          status: latestExecution.status,
          exitCode: latestExecution.exitCode,
          stdout: latestExecution.stdout,
          stderr: latestExecution.stderr,
          message: latestExecution.message
        });
      }
      setBottomView("terminal");
    }
    lastCommandCountRef.current = count;
  }, [runtimeSession]);

  useEffect(() => {
    if (!runtimeSession?.nextAction || runtimeSession.nextAction.kind !== "preview_ready") return;
    const target = `${runtimeSession.id}:${runtimeSession.nextAction.preview.type}:${runtimeSession.nextAction.preview.target}`;
    if (lastPreviewTargetRef.current === target) return;
    if (suppressPreviewOpenRef.current) {
      lastPreviewTargetRef.current = target;
      suppressPreviewOpenRef.current = false;
      return;
    }
    lastPreviewTargetRef.current = target;
    void handleOpenPreview(runtimeSession.nextAction.preview);
  }, [runtimeSession]);

  useEffect(() => {
    if (!workspace) return;
    setRecentWorkspaces((current) => {
      const next = upsertRecentWorkspace(current, workspace, runtimeSession?.id);
      persistRecentWorkspaces(next);
      return next;
    });
    localStorage.setItem(LAST_WORKSPACE_KEY, workspace.path);
  }, [workspace, runtimeSession?.id]);

  useEffect(() => {
    if (!runtimeSession || !workspace) return;
    setRecentSessions((current) => {
      const next = upsertRecentSession(current, runtimeSession, workspace);
      persistRecentSessions(next);
      return next;
    });
    setRecentWorkspaces((current) => {
      const next = current.map((entry) =>
        entry.path === workspace.path ? { ...entry, lastSessionId: runtimeSession.id, lastOpenedAt: new Date().toISOString() } : entry
      );
      persistRecentWorkspaces(next);
      return next;
    });
  }, [runtimeSession, workspace]);

  const sessionTitle = runtimeSession?.agentName ?? "OrchCode";
  const hasSessionView = Boolean(runtimeSession);

  const sessionSummary = runtimeSession
    ? humanSessionStatus(runtimeSession, agentBusy, runtimeConnectionState)
    : workspace
      ? `Connected to ${workspace.name}`
      : "Open a workspace to begin";

  async function refreshWorkspaceState(nextWorkspace?: WorkspaceInfo) {
    const activeWorkspace = nextWorkspace ?? workspace;
    if (!activeWorkspace) return;
    const [nextFiles, nextStatus, nextDiff] = await Promise.all([
      listWorkspaceFiles(),
      getGitStatus(),
      getGitDiff()
    ]);
    setFiles(nextFiles);
    setGitStatus(nextStatus);
    setDiffText(nextDiff.trim() ? nextDiff : "No git diff available.");
  }

  async function activateWorkspace(
    nextPath: string,
    options?: { restoreSession?: boolean; silent?: boolean; recentWorkspaceEntries?: RecentWorkspaceEntry[] }
  ) {
    const trimmed = nextPath.trim();
    if (!trimmed) return;
    const normalizedPath = normalizeWorkspacePath(trimmed);
    runtimeEventUnsubscribeRef.current?.();
    runtimeEventUnsubscribeRef.current = null;
    setRuntimeSession(null);
    setRuntimeConnectionState("connected");
    const nextWorkspace = await openWorkspace(normalizedPath);
    setWorkspacePath(normalizedPath);
    setWorkspace(nextWorkspace);
    if (!options?.silent) {
      setMessage(`Workspace open: ${nextWorkspace.name}`);
    }
    await refreshWorkspaceState(nextWorkspace);

    if (!options?.restoreSession) return;
    const workspaceEntry = (options?.recentWorkspaceEntries ?? recentWorkspaces).find((entry) => normalizeWorkspacePath(entry.path) === normalizedPath);
    const recentSessionId = workspaceEntry?.lastSessionId;
    if (!recentSessionId) return;
    if (!runtimeSessionToken) {
      if (!options?.silent) {
        setMessage(`Workspace open: ${nextWorkspace.name}. Previous session history is available, but live restore is unavailable after restart.`);
      }
      return;
    }
    try {
      suppressPreviewOpenRef.current = true;
      const restoredSession = await getRuntimeSession(recentSessionId, runtimeSessionToken || undefined);
      subscribeToRuntimeSession(recentSessionId, runtimeSessionToken || undefined);
      setRuntimeSession(restoredSession);
    } catch {
      setRecentSessions((current) => {
        const next = current.filter((entry) => entry.id !== recentSessionId);
        persistRecentSessions(next);
        return next;
      });
    }
  }

  async function handleOpenWorkspace() {
    try {
      await activateWorkspace(workspacePath, { restoreSession: true });
    } catch (error) {
      setMessage(String(error));
    }
  }

  async function handlePickWorkspace() {
    try {
      const selected = await pickWorkspaceDirectory();
      if (!selected) {
        setMessage("Workspace selection canceled.");
        return;
      }
      await activateWorkspace(selected, { restoreSession: true });
    } catch (error) {
      setMessage(String(error));
    }
  }

  async function handleRunCommand() {
    try {
      const result = await runWorkspaceCommand(terminalCommand);
      setTerminalResult(result);
      setMessage(result.message ?? `Command ${result.status}.`);
      if (terminalCommand.trim().startsWith("git ")) {
        await refreshWorkspaceState();
      }
    } catch (error) {
      setMessage(String(error));
    }
  }

  function subscribeToRuntimeSession(sessionId: string, sessionToken?: string) {
    runtimeEventUnsubscribeRef.current?.();
    setRuntimeConnectionState("connected");
    runtimeEventUnsubscribeRef.current = subscribeRuntimeEvents(sessionId, sessionToken, {
      onSession: (session) => {
        setRuntimeConnectionState("connected");
        setRuntimeSession(session);
        void mirrorRuntimeSession(session);
      },
      onEvent: (event: AppEvent) => {
        setRuntimeConnectionState("connected");
        void appendSessionEvent("sessionId" in event ? event.sessionId : sessionId, event.type, event as unknown as Record<string, unknown>);
        if (event.type === "runtime.progress.updated") {
          setMessage(event.progress.summary);
        }
        if (event.type === "runtime.run.completed") {
          setMessage(event.summary.nextAction ?? event.summary.summary);
        }
      },
      onError: () => {
        setRuntimeConnectionState("disconnected");
        setMessage("Live updates disconnected. Session state may be stale until the next refresh or runtime completion.");
      }
    });
  }

  async function mirrorRuntimeSession(session: AgentRuntimeSession) {
    try {
      await upsertOrchestrationRun(session);
      for (const run of session.orchestration?.agentRuns ?? []) {
        await upsertAgentRun(session.id, {
          agentId: run.id,
          roleTitle: run.roleTitle ?? run.role ?? run.agentName,
          lifecycleStage: run.lifecycleStage ?? session.lifecycleStage,
          artifactJson: run.artifactJson,
          status: run.status
        });
      }
    } catch {
      // Runtime remains live even if local mirroring has a transient SQLite failure.
    }
  }

  async function handleSelectRecentWorkspace(entry: RecentWorkspaceEntry) {
    try {
      await activateWorkspace(entry.path, { restoreSession: true });
      setSidebarCollapsed(false);
    } catch (error) {
      setMessage(String(error));
    }
  }

  async function handleRestoreRecentSession(entry: RecentSessionEntry) {
    if (!runtimeSessionToken) {
      setMessage("This saved session is history only. Live reconnect requires an active runtime token from this app session.");
      return;
    }
    try {
      await activateWorkspace(entry.workspacePath, { restoreSession: false });
      suppressPreviewOpenRef.current = true;
      subscribeToRuntimeSession(entry.id, runtimeSessionToken || undefined);
      setRuntimeSession(await getRuntimeSession(entry.id, runtimeSessionToken || undefined));
      setSidebarCollapsed(false);
      setMessage(`Restored session: ${entry.title}`);
    } catch (error) {
      setMessage(String(error));
    }
  }

  async function submitPrompt(nextPrompt?: string, queuedMode?: QueuedPrompt["mode"]) {
    const input = nextPrompt ?? prompt;
    if (!workspace) {
      setMessage("Open a workspace before starting an agent session.");
      return;
    }
    if (!input.trim()) {
      setMessage("Write a task in the input area first.");
      return;
    }

    const normalizedInput = input.trim();
    setPromptHistory((current) => {
      const next = [normalizedInput, ...current.filter((entry) => entry !== normalizedInput)].slice(0, MAX_PROMPT_HISTORY);
      localStorage.setItem(PROMPT_HISTORY_KEY, JSON.stringify(next));
      return next;
    });
    setPromptHistoryIndex(null);
    setPromptDraftBeforeHistory("");

    setAgentBusy(true);
    setActivityOpen(false);
    setBottomView("none");
    try {
      const canReuseSession =
        runtimeSession &&
        workspace &&
        runtimeSession.workspacePath === workspace.path;
      let sessionToken = runtimeSessionToken || undefined;
      const sessionId = canReuseSession
        ? runtimeSession.id
        : await (async () => {
            const trustProfile = accessProfile === "auto_review" || accessProfile === "bounded_autonomy" ? "trusted_internal" : "strict_gated";
            const rustRun = await createRuntimeRun(input, trustProfile);
            sessionToken = rustRun.sessionToken;
            setRuntimeSessionToken(rustRun.sessionToken);
            const wantsDemoProvider = /\b(demo|mock)\b/i.test(input);
            const sanitizedProvider =
              providerConfig && providerConfig.providerType === "ollama"
                ? {
                    providerType: providerConfig.providerType,
                    providerName: providerConfig.providerName,
                    baseUrl: providerConfig.baseUrl,
                    selectedModel: providerConfig.selectedModel,
                    isValid: providerConfig.isValid
                  }
                : undefined;
            if (!wantsDemoProvider && (!sanitizedProvider?.isValid || sanitizedProvider.providerType !== "ollama")) {
              throw new Error("Configure a valid local Ollama provider before starting a real coding run. Recommended models: qwen2.5-coder:7b or llama3:8b.");
            }
            return (
              await createRuntimeSession({
                workspacePath: workspace.path,
                mode: wantsDemoProvider ? "demo_mock" : "real_provider",
                trustProfile,
                providerConfig: sanitizedProvider,
                sessionToken: rustRun.sessionToken,
                sessionTokenExpiresAt: rustRun.sessionTokenExpiresAt,
                executionMode: "auto_mode",
                accessProfile,
                thinkFirst,
                safetySettings,
                userPrompt: input
              })
            ).sessionId;
          })();
      subscribeToRuntimeSession(sessionId, sessionToken);
      setRuntimeSession(await getRuntimeSession(sessionId, sessionToken));
      setPrompt("");
      await runRuntimeTurn(sessionId, input, sessionToken);
      const nextSession = await getRuntimeSession(sessionId, sessionToken);
      setRuntimeSession(nextSession);
      await mirrorRuntimeSession(nextSession);
      await autoRunTrustedSafeCommands(nextSession, normalizedInput);
      await refreshWorkspaceState();
      setMessage(
        queuedMode === "steer"
          ? "Steer request completed."
          : nextSession.nextAction?.message ??
            (nextSession.status === "needs_approval" ? "Session is waiting for operator review." : "Session updated.")
      );
    } catch (error) {
      setMessage(String(error));
    } finally {
      setAgentBusy(false);
    }
  }

  async function handleRunAgent() {
    if (agentBusy) {
      enqueuePrompt("queued");
      return;
    }
    await submitPrompt();
  }

  async function refreshRuntimeSession() {
    if (!runtimeSession) return;
    try {
      setRuntimeSession(await getRuntimeSession(runtimeSession.id, runtimeSessionToken || undefined));
    } catch (error) {
      setMessage(String(error));
    }
  }

  async function handleApprovePatch(patchId: string) {
    if (!runtimeSession) return;
    try {
      const result = await approveRuntimePatch(runtimeSession.id, patchId, runtimeSessionToken || undefined);
      setMessage(result.message);
      await refreshRuntimeSession();
    } catch (error) {
      setMessage(String(error));
    }
  }

  async function handleApplyPatch(patchId: string) {
    if (!runtimeSession) return;
    try {
      const applied = await applyRuntimePatch(runtimeSession.id, patchId);
      const updated = await reportRuntimePatchApplyResult(
        runtimeSession.id,
        patchId,
        { status: "applied", message: applied.message },
        runtimeSessionToken || undefined
      );
      setRuntimeSession(updated);
      setMessage(applied.message);
      await refreshRuntimeSession();
      await refreshWorkspaceState();
    } catch (error) {
      try {
        const updated = await reportRuntimePatchApplyResult(
          runtimeSession.id,
          patchId,
          { status: "failed", message: String(error) },
          runtimeSessionToken || undefined
        );
        setRuntimeSession(updated);
      } catch {
        // Keep the original apply error visible even if runtime reporting also fails.
      }
      await refreshRuntimeSession();
      setMessage(String(error));
    }
  }

  async function handleRejectPatch(patchId: string) {
    if (!runtimeSession) return;
    try {
      const result = await rejectRuntimePatch(runtimeSession.id, patchId, runtimeSessionToken || undefined);
      setMessage(result.message);
      await refreshRuntimeSession();
    } catch (error) {
      setMessage(String(error));
    }
  }

  async function runCommandRequest(session: AgentRuntimeSession, request: CommandRequest, autoRun = false) {
    try {
      const result = await executeApprovedCommand(session.id, request.id, request.command, {
        blockDangerousCommands: safetySettings.blockDangerousCommands,
        redactSecrets: safetySettings.redactSecrets,
        allowNetworkCommands: safetySettings.allowNetworkCommands
      });
      const updated = await reportRuntimeCommandResult(
        session.id,
        request.id,
        {
          command: result.command,
          cwd: result.cwd,
          risk: result.risk,
          status: result.status,
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          message: result.message,
          autoRun
        },
        runtimeSessionToken || undefined
      );
      setRuntimeSession((current) => current && current.id === session.id ? updated : current);
      return result;
    } catch (error) {
      const updated = await reportRuntimeCommandResult(
        session.id,
        request.id,
        {
          command: request.command,
          cwd: request.cwd,
          risk: request.risk,
          status: "failed",
          stdout: "",
          stderr: String(error),
          message: String(error),
          autoRun
        },
        runtimeSessionToken || undefined
      );
      setRuntimeSession((current) => current && current.id === session.id ? updated : current);
      throw error;
    }
  }

  async function autoRunTrustedSafeCommands(session: AgentRuntimeSession, input: string) {
    if (session.trustProfile !== "trusted_internal" || !safetySettings.autoRunSafeCommands) return;
    const runnable = session.commandRequests.filter((request) => request.risk === "safe" && (request.status === "requested" || request.status === "approved"));
    if (!runnable.length) return;
    setBottomView("terminal");
    for (const request of runnable) {
      setTerminalCommand(request.command);
      const result = await runCommandRequest(session, request, true);
      setTerminalResult(result);
    }
    if (session.previewRecommendation && /\b(open|launch|run|start|serve)\b/i.test(input)) {
      await handleOpenPreview(session.previewRecommendation);
    }
  }

  async function handleRunPendingCommands() {
    if (!runtimeSession) return;
    const runnable = runtimeSession.commandRequests.filter((request) => request.status === "requested" || request.status === "approved");
    if (!runnable.length) {
      setMessage("No pending command requests.");
      return;
    }
    setBottomView("terminal");
    try {
      for (const request of runnable) {
        setTerminalCommand(request.command);
        const result = await runCommandRequest(runtimeSession, request);
        setTerminalResult(result);
      }
      setMessage("Pending commands were sent through Rust.");
      await refreshWorkspaceState();
    } catch (error) {
      setMessage(String(error));
    }
  }

  async function handleRunSuggestedCommand(command: string, requestId?: string) {
    setTerminalCommand(command);
    setBottomView("terminal");
    try {
      const request = runtimeSession?.commandRequests.find((item) => item.id === requestId);
      const result = runtimeSession && request
        ? await runCommandRequest(runtimeSession, request)
        : await runWorkspaceCommand(command);
      setTerminalResult(result);
      setMessage(result.message ?? `Command ${result.status}.`);
      await refreshWorkspaceState();
    } catch (error) {
      setMessage(String(error));
    }
  }

  function toggleBottomView(nextView: Exclude<BottomView, "none">) {
    setBottomView((current) => (current === nextView ? "none" : nextView));
  }

  function handleNewChat() {
    runtimeEventUnsubscribeRef.current?.();
    runtimeEventUnsubscribeRef.current = null;
    setPrompt("");
    setRuntimeSession(null);
    setActivityOpen(false);
    setThinkFirst(false);
    setQueuedPrompts([]);
    setBottomView("none");
    setTerminalResult(null);
    setRuntimeConnectionState("connected");
    setMessage("Select a workspace and start from the composer.");
  }

  function handleWorkspaceButton() {
    setSidebarCollapsed(false);
    if (workspacePath.trim()) {
      void handleOpenWorkspace();
      return;
    }
    void handlePickWorkspace();
  }

  function handleProjectClick() {
    setSidebarCollapsed(false);
    setActivityOpen(false);
    setBottomView("none");
    setMessage(workspace ? `Workspace selected: ${workspace.name}` : "Open a workspace first.");
  }

  function enqueuePrompt(mode: QueuedPrompt["mode"]) {
    const text = prompt.trim();
    if (!text) {
      setMessage("Write a follow-up message first.");
      return;
    }
    const entry: QueuedPrompt = {
      id: `queued_${queueIdRef.current += 1}`,
      text,
      mode
    };
    setQueuedPrompts((current) => (mode === "steer" ? [entry, ...current] : [...current, entry]));
    setPrompt("");
    setPromptHistoryIndex(null);
    setPromptDraftBeforeHistory("");
    setMessage(mode === "steer" ? "Added as steer. It will run next." : "Added to queue. It will run after the current task.");
  }

  function handlePromptKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      void handleRunAgent();
      return;
    }

    if (event.key === "ArrowUp" && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) {
      const target = event.currentTarget;
      const isCollapsed = target.selectionStart === target.selectionEnd;
      const isAtTop = target.selectionStart === 0;
      if (!isCollapsed || (!isAtTop && prompt.trim())) return;
      event.preventDefault();
      if (!promptHistory.length) return;
      setPromptHistoryIndex((current) => {
        const nextIndex = current === null ? 0 : Math.min(current + 1, promptHistory.length - 1);
        if (current === null) {
          setPromptDraftBeforeHistory(prompt);
        }
        setPrompt(promptHistory[nextIndex] ?? "");
        return nextIndex;
      });
      return;
    }

    if (event.key === "ArrowDown" && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) {
      if (promptHistoryIndex === null) return;
      event.preventDefault();
      setPromptHistoryIndex((current) => {
        if (current === null) return null;
        const nextIndex = current - 1;
        if (nextIndex < 0) {
          setPrompt(promptDraftBeforeHistory);
          return null;
        }
        setPrompt(promptHistory[nextIndex] ?? "");
        return nextIndex;
      });
    }
  }

  async function handleOpenPreview(preview?: AgentRuntimeSession["previewRecommendation"]) {
    preview ??= runtimeSession?.previewRecommendation;
    if (!preview || !workspace) return;
    const target =
      preview.type === "url"
        ? preview.target
        : `file:///${`${workspace.path}\\${preview.target}`.replaceAll("\\", "/")}`;
    try {
      await openExternalTarget(target);
    } catch (error) {
      setMessage(`Preview open failed: ${String(error)}`);
    }
  }

  async function handleCopyText(text: string, label = "Copied output.") {
    try {
      await navigator.clipboard.writeText(text);
      setMessage(label);
    } catch (error) {
      setMessage(`Copy failed: ${String(error)}`);
    }
  }

  return (
    <div className={`app-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""} ${activityOpen ? "activity-open" : ""}`}>
      <header className="frame-bar">
        <div className="frame-bar-left">
          <button className="frame-icon-button" onClick={() => setSidebarCollapsed((current) => !current)} title="Toggle sidebar">
            <PanelLeft size={16} />
          </button>
        </div>

        <div className="frame-bar-right">
          <button className="toolbar-button" onClick={() => setSettingsOpen(true)}>
            <Settings size={15} />
            <span>Settings</span>
          </button>
        </div>
      </header>

      <div className="shell-layout">
        <aside className="project-sidebar">
          <div className="sidebar-top">
            <button className="sidebar-link" onClick={handleNewChat}>
              <MessageSquarePlus size={17} />
              <span>New chat</span>
            </button>
          </div>

          <section className="sidebar-section">
            <div className="sidebar-section-header">
              <span>Projects</span>
            </div>
            <div className="workspace-open-row">
              <input
                ref={workspaceInputRef}
                value={workspacePath}
                onChange={(event) => setWorkspacePath(event.target.value)}
                placeholder="D:\\projects\\my-app"
              />
              <button className="frame-icon-button" onClick={handlePickWorkspace} title="Pick workspace folder">
                <FolderOpen size={16} />
              </button>
            </div>

            {workspace ? (
              <button className="project-item active-project" onClick={handleProjectClick}>
                <div>
                  <strong>{workspace.name}</strong>
                  <span>{runtimeSession ? humanSessionStatus(runtimeSession, agentBusy, runtimeConnectionState) : "Workspace ready"}</span>
                </div>
                <small>{gitStatus?.branch ?? "local"}</small>
              </button>
            ) : (
              <div className="sidebar-empty">Your active workspace will appear here.</div>
            )}

            {runtimeSession ? (
              <button className="project-item" onClick={() => setActivityOpen(true)}>
                <div>
                  <strong>{sessionTitle}</strong>
                  <span>{humanizeLifecycleStage(runtimeSession.lifecycleStage)}</span>
                </div>
                <small>{runtimeSession.tasks.length}</small>
              </button>
            ) : null}

            {recentWorkspaces
              .filter((entry) => entry.path !== workspace?.path)
              .map((entry) => {
                const lastSession = recentSessions.find((sessionEntry) => sessionEntry.id === entry.lastSessionId);
                return (
                  <button key={entry.path} className="project-item" onClick={() => void handleSelectRecentWorkspace(entry)}>
                    <div>
                      <strong>{entry.name}</strong>
                      <span>
                        {lastSession
                          ? `${humanizeRuntimeStatus(lastSession.status)}${!runtimeSessionToken ? " | history only" : ""}`
                          : "Recent workspace"}
                      </span>
                    </div>
                    <small>{shortenPath(entry.path)}</small>
                  </button>
                );
              })}

            {recentSessions
              .filter((entry) => entry.id !== runtimeSession?.id)
              .slice(0, 4)
              .map((entry) => (
                <button
                  key={entry.id}
                  className="project-item"
                  disabled={!runtimeSessionToken}
                  onClick={() => void handleRestoreRecentSession(entry)}
                  title={runtimeSessionToken ? "Try live reconnect" : "History only"}
                >
                  <div>
                    <strong>{entry.title}</strong>
                    <span>
                      {runtimeSessionToken
                        ? `${humanizeRuntimeStatus(entry.status)} | reconnect may work in this app session`
                        : `${humanizeRuntimeStatus(entry.status)} | history only, not reconnectable after restart`}
                    </span>
                  </div>
                  <small>{entry.workspaceName}</small>
                </button>
              ))}
          </section>

          <button className="sidebar-settings" onClick={() => setSettingsOpen(true)}>
            <Settings size={16} />
            <span>Settings</span>
          </button>
        </aside>

        <main className="workspace-canvas">
          <div className="canvas-toolbar">
            <div className="toolbar-group">
              <button className="toolbar-button primary-toolbar" onClick={handleWorkspaceButton}>
                <Code2 size={16} />
                <span>{workspace?.name ?? "Select workspace"}</span>
                <ChevronDown size={14} />
              </button>
            </div>

            <div className="toolbar-group">
              <button
                className={`frame-icon-button ${activityOpen ? "active-toggle" : ""}`}
                onClick={() => setActivityOpen((current) => !current)}
                title="Toggle activity panel"
              >
                <Bot size={16} />
              </button>
              <button
                className={`frame-icon-button ${bottomView === "diff" ? "active-toggle" : ""}`}
                onClick={() => toggleBottomView("diff")}
                title="Toggle diff panel"
              >
                <Diff size={16} />
              </button>
              <button
                className={`frame-icon-button ${bottomView === "terminal" ? "active-toggle" : ""}`}
                onClick={() => toggleBottomView("terminal")}
                title="Toggle terminal"
              >
                <TerminalSquare size={16} />
              </button>
            </div>
          </div>

          <section className={`hero-panel ${hasSessionView ? "session-active" : ""}`}>
            <div className="hero-copy">
              <p className="hero-eyebrow">{sessionSummary}</p>
              {!runtimeSession ? <h1>What should we build?</h1> : null}
            </div>

            {runtimeSession ? (
              <ThreadFeed
                session={runtimeSession}
                connectionState={runtimeConnectionState}
                canReconnect={Boolean(runtimeSessionToken)}
                onOpenActivity={() => setActivityOpen(true)}
                onOpenDiff={() => setBottomView("diff")}
                onQuickReply={submitPrompt}
                onOpenPreview={() => void handleOpenPreview()}
                onRunPendingCommands={() => void handleRunPendingCommands()}
              />
            ) : null}

            <div className="composer-shell">
              <textarea
                value={prompt}
                onChange={(event) => {
                  setPrompt(event.target.value);
                  if (promptHistoryIndex !== null) {
                    setPromptHistoryIndex(null);
                  }
                }}
                onKeyDown={handlePromptKeyDown}
                placeholder="Ask local Codex to create or edit a project with Ollama..."
                rows={4}
              />

              <div className="composer-topline">
                <div className="composer-select-row">
                  <button
                    className={`composer-chip ${thinkFirst ? "active-toggle" : ""}`}
                    onClick={() => setThinkFirst((current) => !current)}
                    type="button"
                  >
                    {thinkFirst ? <ToggleRight size={16} /> : <ToggleLeft size={16} />}
                    <span>Think first</span>
                  </button>
                  <div className="access-menu-shell">
                    <button className="composer-chip access-chip" onClick={() => setAccessMenuOpen((current) => !current)} type="button">
                      <ShieldCheck size={14} />
                      <span>{accessProfileLabel(accessProfile)}</span>
                      <ChevronDown size={14} />
                    </button>
                    {accessMenuOpen ? (
                      <div className="access-menu">
                        {accessOptions.map((option) => (
                          <button
                            key={option.value}
                            className={`access-option ${accessProfile === option.value ? "selected" : ""}`}
                            onClick={() => {
                              setAccessProfile(option.value);
                              setAccessMenuOpen(false);
                              setMessage(option.description);
                            }}
                            type="button"
                          >
                            <strong>{option.label}</strong>
                            <span>{option.description}</span>
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>

                  <button className="send-button" disabled={!workspace} onClick={handleRunAgent}>
                    <Play size={16} />
                  </button>
                  {agentBusy && prompt.trim() ? (
                    <button className="composer-chip" onClick={() => enqueuePrompt("steer")} type="button">
                      <Workflow size={14} />
                      <span>Steer</span>
                    </button>
                  ) : null}
                </div>
              </div>

              <div className="composer-footer">
                <button className="footer-pill" onClick={handleOpenWorkspace}>
                  <FolderOpen size={14} />
                  <span>{workspace?.name ?? "Open workspace"}</span>
                </button>
                <button className="footer-pill" onClick={() => setActivityOpen(true)}>
                  <GitBranch size={14} />
                  <span>Details</span>
                </button>
              </div>

              {agentBusy || queuedPrompts.length ? (
                <div className="queue-strip">
                  {agentBusy ? <span className="queue-pill">Working now</span> : null}
                  {queuedPrompts.length ? (
                    <span className="queue-pill">
                      {queuedPrompts.length} queued
                      {queuedPrompts[0] ? ` | ${queuedPrompts[0].mode === "steer" ? "steer next" : "next in queue"}` : ""}
                    </span>
                  ) : null}
                  {queuedPrompts[0] ? <span className="queue-preview">{summarizeLatestQueueEntry(queuedPrompts[0])}</span> : null}
                </div>
              ) : null}
            </div>

            {!runtimeSession ? (
              <div className="starter-list">
                {starterPrompts.map((starter) => (
                  <button key={starter} className="starter-row" onClick={() => setPrompt(starter)}>
                    <Workflow size={15} />
                    <span>{starter}</span>
                  </button>
                ))}
              </div>
            ) : null}

            <p className="composer-status">{message}</p>
          </section>

          {bottomView !== "none" ? (
            <section className="bottom-drawer">
              <div className="drawer-header">
                <div>
                  <strong>{bottomView === "terminal" ? "Terminal" : "Code review"}</strong>
                  <span>{bottomView === "terminal" ? "Run safe commands when you need them." : "Compare generated changes with the live git diff."}</span>
                </div>
                <button className="frame-icon-button" onClick={() => setBottomView("none")} title="Close drawer">
                  <X size={16} />
                </button>
              </div>

              {bottomView === "terminal" ? (
                <div className="terminal-drawer">
                  <div className="terminal-controls">
                    <input value={terminalCommand} onChange={(event) => setTerminalCommand(event.target.value)} />
                    <button onClick={handleRunCommand}>Run safe command</button>
                    {terminalResult ? (
                      <button
                        onClick={() =>
                          void handleCopyText(formatTerminalResult(terminalResult), "Copied terminal output.")
                        }
                      >
                        <Copy size={14} />
                        Copy
                      </button>
                    ) : null}
                  </div>
                  <pre>
                    {terminalResult ? formatTerminalResult(terminalResult) : "Manual console for safe commands. Medium-risk runtime commands pause for approval. Dangerous commands remain blocked."}
                  </pre>
                </div>
              ) : (
                <div className="diff-drawer">
                  <div className="diff-column">
                    <h3>Proposed diff</h3>
                    <pre>{runtimeSession?.patchProposals[0]?.unifiedDiff || "No patch proposal yet."}</pre>
                  </div>
                  <div className="diff-column">
                    <div className="diff-column-header">
                      <h3>Git diff</h3>
                      <button onClick={() => refreshWorkspaceState()}>Refresh</button>
                    </div>
                    <pre>{diffText || "Open a git workspace to show diff text."}</pre>
                  </div>
                </div>
              )}
            </section>
          ) : null}
        </main>

        {activityOpen ? (
          <aside className="activity-drawer">
            <div className="drawer-header">
              <div>
                <strong>Activity</strong>
                <span>Open details only when you need them.</span>
              </div>
              <button className="frame-icon-button" onClick={() => setActivityOpen(false)} title="Close activity panel">
                <X size={16} />
              </button>
            </div>

            <DrawerSection title="Session">
              {runtimeSession ? (
                <dl className="session-details">
                  <dt>ID</dt>
                  <dd>{runtimeSession.id}</dd>
                  <dt>Status</dt>
                  <dd>{humanizeRuntimeStatus(runtimeSession.status)}</dd>
                  <dt>Stage</dt>
                  <dd>{humanizeLifecycleStage(runtimeSession.lifecycleStage)}</dd>
                  <dt>Connection</dt>
                  <dd>{runtimeConnectionState === "connected" ? "Live updates connected" : "Live updates disconnected; state may be stale"}</dd>
                  <dt>Restore</dt>
                  <dd>{runtimeSessionToken ? "This app session can still attempt reconnects." : "History only after restart; no guaranteed live restore path."}</dd>
                </dl>
              ) : (
                <p className="muted">No active session.</p>
              )}
            </DrawerSection>

            <DrawerSection title="Plan">
              {runtimeSession?.plan ? (
                <>
                  <p className="muted">{runtimeSession.plan.summary}</p>
                  {runtimeSession.plan.steps.map((step) => (
                    <StatusRow key={step.id} label={step.title} status={step.status} detail={step.detail} />
                  ))}
                </>
              ) : runtimeSession?.orchestration?.technicalPlan ? (
                <p className="muted">{runtimeSession.orchestration.technicalPlan.summary}</p>
              ) : (
                <p className="muted">No plan yet.</p>
              )}
            </DrawerSection>

            <DrawerSection title="Tasks">
              {!runtimeSession?.tasks.length ? (
                <p className="muted">No tasks yet.</p>
              ) : (
                runtimeSession.tasks.map((task) => (
                  <StatusRow key={task.id} label={task.title} status={task.status} detail={task.agentRole} />
                ))
              )}
            </DrawerSection>

            <DrawerSection title="Code changes">
              {!runtimeSession?.patchProposals.length ? (
                <p className="muted">No code changes yet.</p>
              ) : (
                runtimeSession.patchProposals.map((proposal) => (
                  <div className="proposal-card" key={proposal.id}>
                    <strong>{proposal.title}</strong>
                    <span>{humanizePatchStatus(proposal.status)} | {proposal.riskLevel} risk</span>
                    <p>{proposal.summary}</p>
                    <div className="proposal-actions">
                      <button onClick={() => handleApprovePatch(proposal.id)} disabled={proposal.status !== "proposed"}>
                        Approve patch write
                      </button>
                      <button onClick={() => handleApplyPatch(proposal.id)} disabled={proposal.status !== "approved"}>
                        Apply approved patch
                      </button>
                      <button onClick={() => handleRejectPatch(proposal.id)} disabled={proposal.status !== "proposed"}>
                        Reject
                      </button>
                    </div>
                  </div>
                ))
              )}
            </DrawerSection>

            <DrawerSection title="Suggested actions">
              {!runtimeSession?.commandRequests.length ? (
                <p className="muted">No suggested actions yet.</p>
              ) : (
                runtimeSession.commandRequests.map((request) => (
                  <div className="proposal-card" key={request.id}>
                    <strong>{request.command}</strong>
                    <span>{request.risk} | {humanizeCommandRequestStatus(request.status)}</span>
                    <p>{request.reason}</p>
                    {request.status === "executed" ? (
                      <button disabled>Executed by Rust</button>
                    ) : request.status === "blocked" ? (
                      <button disabled>Blocked by policy</button>
                    ) : (
                      <button
                        onClick={() => handleRunSuggestedCommand(request.command, request.id)}
                        disabled={request.risk !== "safe"}
                      >
                        Run with Rust
                      </button>
                    )}
                  </div>
                ))
              )}
            </DrawerSection>

            <DrawerSection title="Reviews">
              {!runtimeSession?.orchestration?.securityReviews.length && !runtimeSession?.orchestration?.reviewerSummaries.length ? (
                <p className="muted">No review notes yet.</p>
              ) : (
                [...(runtimeSession.orchestration?.securityReviews ?? []), ...(runtimeSession.orchestration?.reviewerSummaries ?? [])].map((review) => (
                  <StatusRow key={review.id} label={review.reviewer} status={review.status} detail={review.summary} />
                ))
              )}
            </DrawerSection>

            <DrawerSection title="Timeline">
              {!runtimeSession?.orchestration?.orchestrationEvents.length ? (
                <p className="muted">No orchestration events yet.</p>
              ) : (
                runtimeSession.orchestration.orchestrationEvents.slice(-12).map((event) => (
                  <StatusRow key={event.id} label={event.type} status={event.agentName ?? "system"} detail={event.message} />
                ))
              )}
            </DrawerSection>

            <DrawerSection title="Workspace files">
              {!files.length ? (
                <p className="muted">Open a workspace to inspect files.</p>
              ) : (
                files.slice(0, 40).map((file) => (
                  <div className="file-row compact" key={file.path}>
                    <FileText size={14} />
                    <span>{file.path}</span>
                    {file.isSecretCandidate ? <span className="secret-tag">secret</span> : null}
                  </div>
                ))
              )}
            </DrawerSection>

            <DrawerSection title="Status">
              <div className="sidebar-meta">
                <div>
                  <strong>Git</strong>
                  <span>{gitStatus?.statusText || "No git status loaded."}</span>
                </div>
                <div>
                  <strong>Max parallel agents</strong>
                  <span>{String(safetySettings.maxParallelAgents)}</span>
                </div>
                <div>
                  <strong>Patch approval</strong>
                  <span>{safetySettings.requireApprovalForPatches ? "Required" : "Automatic when validated"}</span>
                </div>
              </div>
            </DrawerSection>
          </aside>
        ) : null}
      </div>

      {settingsOpen ? (
        <SettingsDialog
          currentConfig={providerConfig}
          onClose={() => setSettingsOpen(false)}
          onSaved={(config) => {
            setProviderConfig(config);
            setMessage(config.isValid ? "Model provider saved." : config.lastValidationError ?? "Model provider saved as invalid.");
          }}
          onCleared={() => {
            setProviderConfig(null);
            setMessage("Model provider configuration cleared.");
          }}
        />
      ) : null}
    </div>
  );
}

function DrawerSection({
  title,
  children
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="drawer-section">
      <div className="drawer-section-title">{title}</div>
      {children}
    </section>
  );
}

function ThreadFeed({
  session,
  connectionState,
  canReconnect,
  onOpenActivity,
  onOpenDiff,
  onQuickReply,
  onOpenPreview,
  onRunPendingCommands
}: {
  session: AgentRuntimeSession;
  connectionState: "connected" | "disconnected";
  canReconnect: boolean;
  onOpenActivity: () => void;
  onOpenDiff: () => void;
  onQuickReply: (message: string) => void | Promise<void>;
  onOpenPreview: () => void;
  onRunPendingCommands: () => void;
}) {
  const patchStats = getSessionPatchStats(session);
  const agentContracts = getAgentContracts(session);
  const [selectedAgentId, setSelectedAgentId] = useState(agentContracts[0]?.id ?? "");

  useEffect(() => {
    if (!agentContracts.length) {
      setSelectedAgentId("");
      return;
    }
    if (!agentContracts.some((agent) => agent.id === selectedAgentId)) {
      setSelectedAgentId(agentContracts[0]?.id ?? "");
    }
  }, [agentContracts, selectedAgentId]);

  const selectedAgent = agentContracts.find((agent) => agent.id === selectedAgentId) ?? agentContracts[0];

  return (
    <div className="thread-feed">
      {session.messages.map((message) => (
        <div key={message.id} className={`thread-entry ${message.role}`}>
          <div className="thread-entry-header">
            <div className="thread-entry-label">{message.role === "user" ? "You" : message.role === "assistant" ? session.agentName : "System"}</div>
            <CopyMessageButton text={message.content} />
          </div>
          <div className="thread-entry-body">{message.content}</div>
        </div>
      ))}

      <RunHeaderCard session={session} patchStats={patchStats} />
      <ProgressChecklistCard session={session} />
      <AgentStripCard agents={agentContracts} selectedAgentId={selectedAgentId} onSelectAgent={setSelectedAgentId} />
      <AgentDetailCard agent={selectedAgent} />
      <OperatorStateCard session={session} connectionState={connectionState} canReconnect={canReconnect} />
      <EvidenceLedgerCard records={session.decisionLedger ?? []} />
      <ProgressTimeline session={session} />
      <ReasoningSummaryCard session={session} />
      <ToolIntentCard session={session} />
      <ArtifactCard session={session} onOpenDiff={onOpenDiff} onOpenPreview={onOpenPreview} />
      <WorkingTeamCard session={session} onOpenActivity={onOpenActivity} />
      <CodeChangesCard session={session} patchStats={patchStats} onOpenActivity={onOpenActivity} onOpenDiff={onOpenDiff} />
      <ReviewGateCard session={session} />
      <RunResultCard session={session} onOpenPreview={onOpenPreview} />
      <RunSummaryCard session={session} />

      {session.nextAction?.kind === "confirm_plan" ? (
        <ActionCard
          title="Plan review required"
          message={session.nextAction.message}
          actions={
            <>
              <button onClick={() => void onQuickReply("Proceed with implementation.")}>Proceed now</button>
              <button onClick={onOpenActivity}>Review plan</button>
            </>
          }
        />
      ) : null}

      {session.nextAction?.kind === "confirm_preview" ? (
        <ActionCard
          title="Preview launch still pending"
          message={`${session.nextAction.message} Nothing has been launched yet.`}
          actions={
            <>
              <button onClick={() => void onQuickReply("Run it now.")}>Run it now</button>
              <button onClick={() => void onQuickReply("Show me the results first.")}>Show results</button>
              <button onClick={onOpenActivity}>Details</button>
            </>
          }
        />
      ) : null}

      {session.nextAction?.kind === "preview_ready" ? (
        <ActionCard
          title="Preview can be opened"
          message={`${session.nextAction.message} Opening it is still a separate operator action.`}
          actions={
            <button onClick={() => onOpenPreview()}>
              <Globe size={14} />
              Open preview
            </button>
          }
        />
      ) : null}

      {session.nextAction?.kind === "approve_commands" ? (
        <ActionCard
          title="Runtime command approval required"
          message={`${session.nextAction.message} Commands have not run until you approve execution.`}
          actions={
            <>
              <button onClick={() => onRunPendingCommands()}>
                <Play size={14} />
                Run pending commands in Rust
              </button>
              <button onClick={onOpenActivity}>Details</button>
            </>
          }
        />
      ) : null}
    </div>
  );
}

function CopyMessageButton({ text }: { text: string }) {
  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Ignore copy failures in passive message actions.
    }
  }

  return (
    <button className="thread-copy-button" onClick={() => void handleCopy()} title="Copy message">
      <Copy size={14} />
    </button>
  );
}

function RunHeaderCard({
  session,
  patchStats
}: {
  session: AgentRuntimeSession;
  patchStats: PatchChangeStats[];
}) {
  const totals = patchStats.reduce(
    (acc, file) => ({
      files: acc.files + 1,
      additions: acc.additions + file.added,
      deletions: acc.deletions + file.removed
    }),
    { files: 0, additions: 0, deletions: 0 }
  );
  return (
    <section className="run-card run-header-card">
      <div className="run-card-header">
        <div>
          <strong>Run objective</strong>
          <span>{session.userPrompt}</span>
        </div>
      </div>
      <div className="header-metric-grid">
        <div><strong>Mode</strong><span>{humanizeRunMode(session.runMode)}</span></div>
        <div><strong>Lifecycle</strong><span>{humanizeLifecycleStage(session.lifecycleStage)}</span></div>
        <div><strong>Risk</strong><span>{inferSessionRisk(session)}</span></div>
        <div><strong>Changed</strong><span>{formatPatchTotalsLabel(totals.files, totals.additions, totals.deletions)}</span></div>
        <div><strong>Verification</strong><span>{describeVerificationState(session)}</span></div>
        <div><strong>Review</strong><span>{describeReviewReadiness(session)}</span></div>
      </div>
    </section>
  );
}

function ProgressChecklistCard({ session }: { session: AgentRuntimeSession }) {
  const phases = getDisplayRunPhases(session);
  return (
    <section className="run-card timeline-card">
      <div className="run-card-header">
        <div>
          <strong>Run checklist</strong>
          <span>Deep local work is shown as explicit phases instead of hidden turns.</span>
        </div>
      </div>
      <div className="timeline-list">
        {phases.map((phase) => (
          <div key={phase.id} className={`timeline-item ${phase.status === "active" ? "running" : phase.status}`}>
            <span className="timeline-dot" />
            <div>
              <strong>{humanizeRunPhase(phase.id)}</strong>
              <span>{phase.summary}</span>
              {typeof phase.evidenceCount === "number" ? <small>{phase.evidenceCount} evidence item(s)</small> : null}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function AgentStripCard({
  agents,
  selectedAgentId,
  onSelectAgent
}: {
  agents: AgentContractView[];
  selectedAgentId: string;
  onSelectAgent: (agentId: string) => void;
}) {
  if (!agents.length) return null;
  return (
    <section className="run-card">
      <div className="run-card-header">
        <div>
          <strong>Agent strip</strong>
          <span>Each chip reflects a real reported agent or the current local coordinator.</span>
        </div>
      </div>
      <div className="agent-strip">
        {agents.map((agent) => (
          <button
            key={agent.id}
            className={`agent-chip ${selectedAgentId === agent.id ? "selected" : ""} ${agent.status}`}
            onClick={() => onSelectAgent(agent.id)}
          >
            <strong>{agent.name}</strong>
            <span>{agent.role}</span>
            <small>{humanizeAgentStatus(agent.status)} | {agent.currentAction}</small>
            <small>{agent.diffLabel}</small>
          </button>
        ))}
      </div>
    </section>
  );
}

function AgentDetailCard({ agent }: { agent?: AgentContractView }) {
  if (!agent) return null;
  return (
    <section className="run-card">
      <div className="run-card-header">
        <div>
          <strong>{agent.name}</strong>
          <span>{agent.role}</span>
        </div>
      </div>
      <div className="agent-detail-grid">
        <div><strong>Objective</strong><span>{agent.objective}</span></div>
        <div><strong>Current action</strong><span>{agent.currentAction}</span></div>
        <div><strong>Owned paths</strong><span>{agent.ownedPaths.length ? agent.ownedPaths.join(", ") : "Not reported yet."}</span></div>
        <div><strong>Forbidden paths</strong><span>{agent.forbiddenPaths.length ? agent.forbiddenPaths.join(", ") : "Not reported yet."}</span></div>
        <div><strong>Changed files</strong><span>{agent.changedFiles.length ? agent.changedFiles.join(", ") : "Not reported yet."}</span></div>
        <div><strong>Commands</strong><span>{agent.commandsRun.length ? agent.commandsRun.join(", ") : "Not reported yet."}</span></div>
        <div><strong>Risk</strong><span>{agent.riskLevel}</span></div>
        <div><strong>Blockers</strong><span>{agent.blockers.length ? agent.blockers.join(", ") : "None reported."}</span></div>
      </div>
      <div className="timeline-list compact-list">
        {agent.recentActions.length ? agent.recentActions.map((action, index) => (
          <div className="timeline-item completed" key={`${agent.id}-${index}`}>
            <span className="timeline-dot" />
            <div><span>{action}</span></div>
          </div>
        )) : (
          <div className="timeline-item running">
            <span className="timeline-dot" />
            <div><span>Not reported yet.</span></div>
          </div>
        )}
      </div>
    </section>
  );
}

function EvidenceLedgerCard({ records }: { records: DecisionRecord[] }) {
  if (!records.length) return null;
  return (
    <section className="run-card timeline-card">
      <div className="run-card-header">
        <div>
          <strong>Evidence ledger</strong>
          <span>Findings, decisions, and uncertainty are visible without exposing hidden chain-of-thought.</span>
        </div>
      </div>
      <div className="timeline-list">
        {records.slice(-8).map((record) => (
          <div className="timeline-item completed" key={record.id}>
            <span className="timeline-dot" />
            <div>
              <strong>{humanizeDecisionCategory(record.category)} | {record.createdByAgent}</strong>
              <span>{record.finding}</span>
              <small>Decision: {record.decision}</small>
              <small>Evidence: {describeEvidenceRefs(record.evidenceRefs)} | Files: {record.linkedFiles.length ? record.linkedFiles.join(", ") : "none"}</small>
              {record.uncertainty ? <small>Uncertainty: {record.uncertainty}</small> : null}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function ReviewGateCard({ session }: { session: AgentRuntimeSession }) {
  const gate = session.reviewGate;
  if (!gate) return null;
  return (
    <section className="run-card summary-card">
      <div className="run-card-header">
        <div>
          <strong>Review gate</strong>
          <span>{gate.summary}</span>
        </div>
      </div>
      <div className="summary-list">
        <div className="summary-line compact">Total diff: {formatPatchTotalsLabel(gate.totalFilesChanged, gate.totalAdditions, gate.totalDeletions)}</div>
        <div className="summary-line compact">Recommendation: {humanizeReviewRecommendation(gate.recommendation)}</div>
        <div className="summary-line compact">Risky areas: {gate.riskyAreas.length ? gate.riskyAreas.join(", ") : "None reported."}</div>
        <div className="summary-line compact">Unresolved blockers: {gate.unresolvedBlockers.length ? gate.unresolvedBlockers.join(" | ") : "None."}</div>
        {gate.changesByAgent.length ? gate.changesByAgent.map((entry) => (
          <div className="summary-line compact" key={entry.agentName}>
            {entry.agentName}: {formatPatchTotalsLabel(entry.fileCount, entry.additions, entry.deletions)}
          </div>
        )) : (
          <div className="summary-line compact">Agent attribution: Not reported yet.</div>
        )}
      </div>
    </section>
  );
}

function ProgressTimeline({ session }: { session: AgentRuntimeSession }) {
  const events = session.progressEvents.slice(-12);
  if (!events.length && session.status !== "running") return null;
  return (
    <section className="run-card timeline-card">
      <div className="run-card-header">
        <div>
          <strong>Current work</strong>
          <span>{events.at(-1)?.summary ?? "Starting the run and preparing the plan."}</span>
        </div>
      </div>
      <div className="timeline-list">
        {(events.length ? events : []).map((event) => (
          <div key={event.id} className={`timeline-item ${event.status}`}>
            <span className="timeline-dot" />
            <div>
              <strong>{event.taskTitle ?? event.stage}</strong>
              <span>
                {event.agentName ? `${event.agentName} | ` : ""}
                {event.summary}
              </span>
              {event.targetFiles.length ? <small>{event.targetFiles.slice(0, 4).join(", ")}</small> : null}
            </div>
          </div>
        ))}
        {!events.length ? (
          <div className="timeline-item running">
            <span className="timeline-dot" />
            <div>
              <strong>Preparing</strong>
              <span>The agent is starting your request.</span>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function ReasoningSummaryCard({ session }: { session: AgentRuntimeSession }) {
  const summaries = [
    session.plan?.summary ? `Plan: ${session.plan.summary}` : "",
    ...(session.reasoningSummaries ?? []),
    session.verificationResult?.summary ? `Verification: ${session.verificationResult.summary}` : ""
  ].filter(Boolean).slice(-5);
  if (!summaries.length) return null;
  return (
    <section className="run-card timeline-card reasoning-card">
      <div className="run-card-header">
        <div>
          <strong>Reasoning summary</strong>
          <span>Visible rationale, decisions, and verification notes without hidden chain-of-thought.</span>
        </div>
      </div>
      <div className="timeline-list">
        {summaries.map((summary, index) => (
          <div className="timeline-item completed" key={`${index}-${summary}`}>
            <span className="timeline-dot" />
            <div>
              <strong>Step {index + 1}</strong>
              <span>{summary}</span>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function ToolIntentCard({ session }: { session: AgentRuntimeSession }) {
  const intents = (session.toolIntents ?? []).slice(-8);
  if (!intents.length) return null;
  return (
    <section className="run-card timeline-card">
      <div className="run-card-header">
        <div>
          <strong>Tool intents</strong>
          <span>Reviewable actions before Rust changes anything.</span>
        </div>
      </div>
      <div className="timeline-list">
        {intents.map((intent) => (
          <div className={`timeline-item ${intent.status}`} key={intent.id}>
            <span className="timeline-dot" />
            <div>
              <strong>{intent.title}</strong>
              <span>{intent.summary}</span>
              <small>{intent.type} | {intent.status}</small>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function OperatorStateCard({
  session,
  connectionState,
  canReconnect
}: {
  session: AgentRuntimeSession;
  connectionState: "connected" | "disconnected";
  canReconnect: boolean;
}) {
  return (
    <section className="run-card summary-card">
      <div className="run-card-header">
        <div>
          <strong>Operator state</strong>
          <span>{describeOperatorHeadline(session, connectionState)}</span>
        </div>
      </div>
      <div className="summary-list">
        <div className="summary-line compact">Connection: {connectionState === "connected" ? "Live updates connected." : "Live updates disconnected; visible state may lag until refresh."}</div>
        <div className="summary-line compact">Restore: {canReconnect ? "This app session can still try a live reconnect while the runtime token remains valid." : "Saved sessions are history only after restart; no guaranteed live restore path."}</div>
        <div className="summary-line compact">Write state: {describePatchState(session)}</div>
        <div className="summary-line compact">Command state: {describeCommandState(session)}</div>
        <div className="summary-line compact">Verification: {describeVerificationState(session)}</div>
        <div className="summary-line compact">Audit trail: {describeAuditTrail(session)}</div>
      </div>
    </section>
  );
}

function ArtifactCard({
  session,
  onOpenDiff,
  onOpenPreview
}: {
  session: AgentRuntimeSession;
  onOpenDiff: () => void;
  onOpenPreview: () => void;
}) {
  const artifacts = (session.artifacts ?? []).slice(-6);
  if (!artifacts.length) return null;
  return (
    <section className="run-card">
      <div className="run-card-header">
        <div>
          <strong>Artifacts</strong>
          <span>Audit trail of plans, diffs, command results, previews, and verification records.</span>
        </div>
      </div>
      <div className="artifact-grid">
        {artifacts.map((artifact) => (
          <div className="artifact-tile" key={artifact.id}>
            <div className="artifact-title">
              <FileText size={15} />
              <strong>{artifact.title}</strong>
              <span>{artifact.type}</span>
            </div>
            <p>{artifact.summary}</p>
            {artifact.type === "diff" ? <button onClick={onOpenDiff}>Review diff record</button> : null}
            {artifact.type === "preview" ? <button onClick={() => onOpenPreview()}>Open preview target</button> : null}
          </div>
        ))}
      </div>
    </section>
  );
}

function RunResultCard({
  session,
  onOpenPreview
}: {
  session: AgentRuntimeSession;
  onOpenPreview: () => void;
}) {
  const latestExecution = session.commandExecutions.at(-1);
  if (!latestExecution && !session.previewRecommendation) return null;
  return (
    <section className="run-card summary-card">
      <div className="run-card-header">
        <div>
          <strong>Run result</strong>
          <span>
            {latestExecution
              ? `${latestExecution.command} | ${humanizeCommandResultStatus(latestExecution.status)}`
              : session.previewRecommendation?.description ?? "Preview prepared"}
          </span>
        </div>
      </div>
      <div className="summary-list">
        {latestExecution ? (
          <>
            <div className="summary-line compact">Command: {latestExecution.command}</div>
            <div className="summary-line compact">Mode: {shouldDescribeBackground(latestExecution.command) ? "Background" : "Foreground"}</div>
            <div className="summary-line compact">Status: {humanizeCommandResultStatus(latestExecution.status)}</div>
            {latestExecution.message ? <div className="summary-line compact">{latestExecution.message}</div> : null}
          </>
        ) : null}
        {session.previewRecommendation ? (
          <>
            <div className="summary-line compact">Preview target: {session.previewRecommendation.target}</div>
            <div className="summary-line compact">Preview state: Prepared for review only. It does not open until you choose to launch it.</div>
            <div className="command-actions">
              <button onClick={() => onOpenPreview()}>
                <Globe size={14} />
                Open preview
              </button>
            </div>
          </>
        ) : null}
      </div>
    </section>
  );
}

function WorkingTeamCard({
  session,
  onOpenActivity
}: {
  session: AgentRuntimeSession;
  onOpenActivity: () => void;
}) {
  const statuses: AgentWorkStatus[] = session.agentWorkStatuses.length
    ? session.agentWorkStatuses
    : (session.orchestration?.workOrders ?? []).map((order) => ({
        agentName: order.agentName,
        role: order.dynamicRole,
        taskTitle: order.objective,
        objective: order.objective,
        status: "queued" as const,
        targetFiles: order.requiredArtifacts,
        updatedAt: new Date().toISOString()
      }));
  if (!statuses.length) return null;
  return (
    <section className="run-card">
      <div className="run-card-header">
        <div>
          <strong>Working team</strong>
          <span>{session.delegationDecision?.rationale ?? "Specialists are selected from the task requirements."}</span>
        </div>
        <button className="activity-link" onClick={onOpenActivity}>Details</button>
      </div>
      <div className="work-team-grid">
        {statuses.map((status) => (
          <div className={`work-agent ${status.status}`} key={status.agentName}>
            <div className="work-agent-title">
              <strong>{prettyAgentName(status.agentName)}</strong>
              <span>{status.status}</span>
            </div>
            <p>{status.objective || status.taskTitle}</p>
            {status.targetFiles.length ? <small>{status.targetFiles.slice(0, 3).join(", ")}</small> : null}
            {status.selfCheck ? (
              <small>
                Self-check: {status.selfCheck.failedCriteria.length || status.selfCheck.missingItems.length ? "needs work" : "passed"}
              </small>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}

function CodeChangesCard({
  session,
  patchStats,
  onOpenActivity,
  onOpenDiff
}: {
  session: AgentRuntimeSession;
  patchStats: PatchChangeStats[];
  onOpenActivity: () => void;
  onOpenDiff: () => void;
}) {
  if (!session.patchProposals.length && !patchStats.length) return null;
  return (
    <section className="run-card code-changes-card">
      <div className="run-card-header">
        <div>
          <strong>Code changes</strong>
          <span>
            {session.patchProposals.length} proposal(s) | {patchStats.length} file(s) touched
          </span>
        </div>
        <div className="command-actions">
          <button onClick={onOpenDiff}>Review changes</button>
          <button onClick={onOpenActivity}>Open file list</button>
        </div>
      </div>
      <div className="changed-file-list">
        {patchStats.map((file) => (
          <div className="changed-file-row" key={file.path}>
            <span>{file.path}</span>
            <strong>
              +{file.added} -{file.removed}
            </strong>
          </div>
        ))}
      </div>
      <div className="patch-status-line">
        {session.patchProposals.map((proposal) => (
          <span key={proposal.id}>
            {proposal.title}: {humanizePatchStatus(proposal.status)}
          </span>
        ))}
      </div>
    </section>
  );
}

function RunSummaryCard({ session }: { session: AgentRuntimeSession }) {
  if (!session.runSummary) return null;
  return (
    <section className="run-card summary-card">
      <div className="run-card-header">
        <div>
          <strong>Result</strong>
          <span>{session.runSummary.summary}</span>
        </div>
      </div>
      <div className="summary-list">
        {session.runSummary.gates.map((gate) => (
          <div className="summary-line compact" key={gate.name}>
            {gate.name}: {gate.status}
          </div>
        ))}
        {session.runSummary.nextAction ? <div className="summary-line compact">{session.runSummary.nextAction}</div> : null}
      </div>
    </section>
  );
}

function CompactNote({
  title,
  action,
  children
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="compact-note">
      <div className="compact-note-header">
        <strong>{title}</strong>
        {action}
      </div>
      <div className="compact-note-body">{children}</div>
    </div>
  );
}

function ActionCard({
  title,
  message,
  actions
}: {
  title: string;
  message: string;
  actions: React.ReactNode;
}) {
  return (
    <div className="action-card">
      <strong>{title}</strong>
      <div className="thread-entry-body">{message}</div>
      <div className="command-actions">{actions}</div>
    </div>
  );
}

function ActivityCard({
  title,
  subtitle,
  action,
  children
}: {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="activity-card">
      <div className="activity-card-header">
        <div>
          <strong>{title}</strong>
          {subtitle ? <span>{subtitle}</span> : null}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function StatusRow({ label, status, detail }: { label: string; status: string; detail?: string }) {
  const iconClass =
    status === "done" || status === "completed"
      ? "done-icon"
      : status === "blocked" || status === "failed" || status === "error"
        ? "blocked-icon"
        : "pending-icon";
  return (
    <div className="status-row">
      <Bot size={15} className={iconClass} />
      <div>
        <strong>{label}</strong>
        <span>
          {status}
          {detail ? ` | ${detail}` : ""}
        </span>
      </div>
    </div>
  );
}

function getSessionPatchStats(session: AgentRuntimeSession): PatchChangeStats[] {
  if (session.runSummary?.filesChanged.length) return session.runSummary.filesChanged;
  const progressStats = session.progressEvents.flatMap((event) => event.patchStats ?? []);
  if (progressStats.length) return mergePatchStats(progressStats);
  return mergePatchStats(session.patchProposals.flatMap((proposal) => computePatchStats(proposal.unifiedDiff, proposal.filesChanged)));
}

function computePatchStats(
  unifiedDiff: string,
  filesChanged: Array<{ path: string; changeType: PatchChangeStats["changeType"] }>
): PatchChangeStats[] {
  const stats = new Map<string, PatchChangeStats>();
  for (const file of filesChanged) {
    stats.set(file.path, { path: file.path, added: 0, removed: 0, changeType: file.changeType });
  }
  let currentPath = filesChanged[0]?.path;
  for (const line of unifiedDiff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      currentPath = match?.[2] ?? currentPath;
      if (currentPath && !stats.has(currentPath)) {
        stats.set(currentPath, { path: currentPath, added: 0, removed: 0, changeType: "modify" });
      }
      continue;
    }
    if (line.startsWith("+++ b/")) {
      currentPath = line.slice("+++ b/".length);
      if (!stats.has(currentPath)) {
        stats.set(currentPath, { path: currentPath, added: 0, removed: 0, changeType: "modify" });
      }
      continue;
    }
    if (!currentPath) continue;
    const target = stats.get(currentPath) ?? { path: currentPath, added: 0, removed: 0, changeType: "modify" as const };
    if (line.startsWith("+") && !line.startsWith("+++")) target.added += 1;
    if (line.startsWith("-") && !line.startsWith("---")) target.removed += 1;
    stats.set(currentPath, target);
  }
  return [...stats.values()];
}

function mergePatchStats(stats: PatchChangeStats[]) {
  const merged = new Map<string, PatchChangeStats>();
  for (const stat of stats) {
    const current = merged.get(stat.path);
    merged.set(stat.path, {
      path: stat.path,
      changeType: stat.changeType,
      added: (current?.added ?? 0) + stat.added,
      removed: (current?.removed ?? 0) + stat.removed
    });
  }
  return [...merged.values()];
}

type AgentContractView = {
  id: string;
  name: string;
  role: string;
  status: "idle" | "running" | "completed" | "blocked" | "failed";
  objective: string;
  currentAction: string;
  ownedPaths: string[];
  forbiddenPaths: string[];
  recentActions: string[];
  changedFiles: string[];
  commandsRun: string[];
  riskLevel: "low" | "medium" | "high";
  blockers: string[];
  diffLabel: string;
};

function getDisplayRunPhases(session: AgentRuntimeSession): RunPhase[] {
  if (session.runPhases?.length) return session.runPhases;
  const pending = (id: RunPhase["id"], summary: string): RunPhase => ({ id, status: "pending", summary });
  return [
    pending("inspect_workspace", "Workspace inspection has not been reported yet."),
    pending("build_repo_map", "Repo map has not been reported yet."),
    pending("split_agents", "Agent planning has not been reported yet."),
    pending("agents_running", "Execution has not been reported yet."),
    pending("integrate_changes", "No integrated diff has been reported yet."),
    pending("run_verification", session.verificationResult?.summary ?? "Verification has not been reported yet."),
    pending("review_final_diff", session.runSummary?.nextAction ?? "Review gate is not ready yet."),
    pending("final_report", session.runSummary?.summary ?? "Final report is not ready yet.")
  ];
}

function getAgentContracts(session: AgentRuntimeSession): AgentContractView[] {
  const agentRuns = session.orchestration?.agentRuns ?? [];
  if (agentRuns.length) {
    return agentRuns.map((agent) => ({
      id: agent.id,
      name: agent.agentName,
      role: agent.roleTitle ?? agent.role,
      status: agent.status,
      objective: agent.objective ?? session.userPrompt,
      currentAction: agent.currentAction ?? agent.currentTask ?? "Not reported yet.",
      ownedPaths: agent.ownedPaths ?? [],
      forbiddenPaths: agent.forbiddenPaths ?? [],
      recentActions: agent.recentActions ?? (agent.lastEvent ? [agent.lastEvent] : []),
      changedFiles: agent.changedFiles ?? [],
      commandsRun: agent.commandsRun ?? [],
      riskLevel: agent.riskLevel ?? "medium",
      blockers: agent.blockers ?? [],
      diffLabel: formatPatchTotalsLabel(agent.diffStats?.fileCount, agent.diffStats?.additions, agent.diffStats?.deletions)
    }));
  }

  return (session.agentWorkStatuses ?? []).map((status, index) => ({
    id: `${status.agentName}-${index}`,
    name: status.agentName,
    role: status.role,
    status: mapProgressStatusToAgentStatus(status.status),
    objective: status.objective,
    currentAction: status.summary ?? status.taskTitle,
    ownedPaths: [],
    forbiddenPaths: [],
    recentActions: [status.taskTitle],
    changedFiles: status.targetFiles,
    commandsRun: [],
    riskLevel: "medium",
    blockers: [],
    diffLabel: formatPatchTotalsLabel(status.targetFiles.length)
  }));
}

function prettyAgentName(name: string) {
  return name.replace(/Agent$/, "").replace(/([a-z])([A-Z])/g, "$1 $2");
}

function mapProgressStatusToAgentStatus(status: AgentWorkStatus["status"]): AgentContractView["status"] {
  if (status === "failed") return "failed";
  if (status === "blocked") return "blocked";
  if (status === "completed") return "completed";
  if (status === "running") return "running";
  return "idle";
}

function humanizeRunMode(mode: RunMode | undefined) {
  switch (mode) {
    case "quick_fix":
      return "Quick fix";
    case "normal_run":
      return "Normal run";
    case "deep_audit":
      return "Deep local run";
    case "soak_mode":
      return "Soak mode";
    case "paranoid_mode":
      return "Paranoid mode";
    default:
      return "Local run";
  }
}

function humanizeRunPhase(phase: RunPhase["id"]) {
  return phase
    .replaceAll("_", " ")
    .replace(/\b\w/g, (value) => value.toUpperCase());
}

function inferSessionRisk(session: AgentRuntimeSession) {
  if (session.reviewGate?.recommendation === "do_not_apply") return "High";
  if (session.patchProposals.some((proposal) => proposal.riskLevel === "high")) return "High";
  if (session.patchProposals.some((proposal) => proposal.riskLevel === "medium")) return "Medium";
  return "Low";
}

function describeReviewReadiness(session: AgentRuntimeSession) {
  if (session.reviewGate) return humanizeReviewRecommendation(session.reviewGate.recommendation);
  if (session.status === "needs_approval") return "Review required";
  if (session.status === "completed") return "Ready";
  return "Not ready";
}

function humanizeReviewRecommendation(recommendation: NonNullable<AgentRuntimeSession["reviewGate"]>["recommendation"]) {
  switch (recommendation) {
    case "ready":
      return "Ready for apply review";
    case "caution":
      return "Caution";
    case "do_not_apply":
      return "Do not apply";
  }
}

function humanizeDecisionCategory(category: DecisionRecord["category"]) {
  return category.replace("_", " ");
}

function humanizeAgentStatus(status: AgentContractView["status"]) {
  switch (status) {
    case "idle":
      return "Idle";
    case "running":
      return "Running";
    case "completed":
      return "Done";
    case "blocked":
      return "Blocked";
    case "failed":
      return "Failed";
  }
}

function describeEvidenceRefs(evidenceRefs: EvidenceRef[]) {
  if (!evidenceRefs.length) return "None recorded";
  const hasLineOrSymbolRef = evidenceRefs.some((ref) => ref.type === "file" && (ref.lineHint || ref.symbol));
  const hasNonFileRef = evidenceRefs.some((ref) => ref.type !== "file");
  const notes = [hasLineOrSymbolRef ? "line or symbol refs included" : "line or symbol refs not reported yet"];
  if (hasNonFileRef) notes.push("command, test, or artifact refs included");
  return `${evidenceRefs.length} item(s); ${notes.join("; ")}`;
}

function formatPatchTotalsLabel(fileCount?: number, additions?: number, deletions?: number) {
  const filesLabel = typeof fileCount === "number" ? `${fileCount} file(s)` : "File count not reported yet.";
  if (typeof additions === "number" && typeof deletions === "number") {
    return `${filesLabel}, +${additions} -${deletions}`;
  }
  return `${filesLabel}, line diff not reported yet.`;
}

function accessProfileLabel(profile: AccessProfile) {
  return accessOptions.find((option) => option.value === profile)?.label ?? "Default permissions";
}

function humanSessionStatus(
  session: AgentRuntimeSession | null,
  agentBusy = false,
  connectionState: "connected" | "disconnected" = "connected"
) {
  if (!session) return "Open a workspace to begin";
  if (connectionState === "disconnected" && session.status === "running") return "Live updates disconnected";
  if (agentBusy) return "Working on your request";

  switch (session.nextAction?.kind) {
    case "confirm_plan":
      return "Plan review required";
    case "confirm_preview":
      return "Preview launch pending";
    case "preview_ready":
      return "Preview available";
    case "approve_commands":
      return "Waiting on command approval";
    default:
      break;
  }

  if (session.status === "needs_approval") return "Waiting for operator review";
  if (session.status === "completed") return "Done";
  if (session.status === "running") return "Working on your request";
  if (session.status === "failed") return "Run failed";
  return "Session active";
}

function describeOperatorHeadline(session: AgentRuntimeSession, connectionState: "connected" | "disconnected") {
  if (connectionState === "disconnected" && session.status === "running") {
    return "The run may still be active, but the live event stream is disconnected.";
  }
  if (session.nextAction?.kind === "approve_commands") {
    return "Runtime commands are queued and waiting for operator execution.";
  }
  if (session.patchProposals.some((proposal) => proposal.status === "approved")) {
    return "A reviewed patch is waiting for explicit apply.";
  }
  if (session.patchProposals.some((proposal) => proposal.status === "proposed")) {
    return "Code changes are proposed but not written yet.";
  }
  if (session.verificationResult?.status === "pending") {
    return "Writes may be complete, but verification is still pending.";
  }
  return "This card summarizes what has happened, what is still pending, and what the UI can safely promise.";
}

function describePatchState(session: AgentRuntimeSession) {
  if (session.patchProposals.some((proposal) => proposal.status === "proposed")) {
    return "Patch review required before any write occurs.";
  }
  if (session.patchProposals.some((proposal) => proposal.status === "approved")) {
    return "Patch approved, but Rust apply has not happened yet.";
  }
  if (session.patchProposals.some((proposal) => proposal.status === "apply_failed")) {
    return "A patch apply attempt failed; inspect the summary artifacts before retrying.";
  }
  if (session.patchProposals.some((proposal) => proposal.status === "applied")) {
    return "At least one patch was applied through Rust.";
  }
  return "No patch write is pending.";
}

function describeCommandState(session: AgentRuntimeSession) {
  if (session.commandRequests.some((request) => request.status === "requested" || request.status === "approved")) {
    return "One or more runtime commands are waiting for approval or execution.";
  }
  const latestExecution = session.commandExecutions.at(-1);
  if (latestExecution) {
    return `Latest runtime command is recorded as ${humanizeCommandResultStatus(latestExecution.status)}.`;
  }
  return "No runtime command is pending.";
}

function describeVerificationState(session: AgentRuntimeSession) {
  if (!session.verificationResult) return "No verification record yet.";
  if (session.verificationResult.status === "pending") return "Verification is still pending.";
  if (session.verificationResult.status === "failed") return "Verification failed; inspect the checks before trusting the output.";
  return "Verification passed for the recorded checks.";
}

function describeAuditTrail(session: AgentRuntimeSession) {
  const previewArtifacts = session.artifacts.filter((artifact) => artifact.type === "preview").length;
  const verificationArtifacts = session.artifacts.filter((artifact) => artifact.type === "verification").length;
  const commandArtifacts = session.artifacts.filter((artifact) => artifact.type === "command_result").length;
  return `${session.artifacts.length} artifact record(s), ${commandArtifacts} command result(s), ${verificationArtifacts} verification record(s), ${previewArtifacts} preview record(s).`;
}

function humanizeRuntimeStatus(status: string) {
  switch (status) {
    case "needs_approval":
      return "waiting for review";
    case "completed":
      return "completed";
    case "running":
      return "running";
    case "failed":
      return "failed";
    case "created":
      return "created";
    default:
      return status.replaceAll("_", " ");
  }
}

function humanizeLifecycleStage(stage: string) {
  return stage.toLowerCase().replaceAll("_", " ");
}

function humanizePatchStatus(status: string) {
  return status.replaceAll("_", " ");
}

function humanizeCommandRequestStatus(status: string) {
  return status === "requested" ? "requested, not executed" : status.replaceAll("_", " ");
}

function humanizeCommandResultStatus(status: string) {
  return status === "approval_required" ? "approval required" : status.replaceAll("_", " ");
}

function summarizeLatestQueueEntry(entry: QueuedPrompt | undefined) {
  if (!entry) return "";
  const compact = entry.text.replace(/\s+/g, " ").trim();
  return compact.length > 58 ? `${compact.slice(0, 58)}...` : compact;
}

function formatTerminalResult(result: CommandResult) {
  return [
    `$ ${result.command}`,
    `risk: ${result.risk} status: ${result.status}`,
    normalizeTerminalText(result.message ?? ""),
    normalizeTerminalText(result.stdout),
    normalizeTerminalText(result.stderr)
  ]
    .filter(Boolean)
    .join("\n");
}

function normalizeTerminalText(text: string) {
  if (!text) return "";
  return text.replace(
    /Serving HTTP on :: port (\d+) \(http:\/\/\[\:\:\]:(\d+)\/\) \.\.\./g,
    (_match, shownPort, urlPort) =>
      `Serving HTTP on port ${shownPort}.\nLocal preview: http://127.0.0.1:${urlPort}/\nOriginal server output: http://[::]:${urlPort}/`
  );
}

function shouldDescribeBackground(command: string) {
  return /\b(dev|serve|http\.server|vite|next dev|react-scripts start)\b/i.test(command);
}

function readStoredJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function persistRecentWorkspaces(entries: RecentWorkspaceEntry[]) {
  localStorage.setItem(RECENT_WORKSPACES_KEY, JSON.stringify(entries));
}

function persistRecentSessions(entries: RecentSessionEntry[]) {
  localStorage.setItem(RECENT_SESSIONS_KEY, JSON.stringify(entries));
}

function upsertRecentWorkspace(
  current: RecentWorkspaceEntry[],
  workspace: WorkspaceInfo,
  sessionId?: string
) {
  const nextEntry: RecentWorkspaceEntry = {
    path: workspace.path,
    name: workspace.name,
    lastOpenedAt: new Date().toISOString(),
    lastSessionId: sessionId
  };
  return [nextEntry, ...current.filter((entry) => entry.path !== workspace.path)].slice(0, MAX_RECENT_WORKSPACES);
}

function upsertRecentSession(
  current: RecentSessionEntry[],
  session: AgentRuntimeSession,
  workspace: WorkspaceInfo
) {
  const nextEntry: RecentSessionEntry = {
    id: session.id,
    workspacePath: workspace.path,
    workspaceName: workspace.name,
    title: session.agentName || session.userPrompt || "Session",
    status: humanSessionStatus(session, false),
    updatedAt: session.updatedAt
  };
  return [nextEntry, ...current.filter((entry) => entry.id !== session.id)].slice(0, MAX_RECENT_SESSIONS);
}

function shortenPath(targetPath: string) {
  const compact = targetPath.replaceAll("\\", "/");
  return compact.length > 28 ? `...${compact.slice(-28)}` : compact;
}

function normalizeWorkspacePath(targetPath: string) {
  return targetPath.startsWith("\\\\?\\") ? targetPath.slice(4) : targetPath;
}

function SettingsDialog({
  currentConfig,
  onClose,
  onSaved,
  onCleared
}: {
  currentConfig: ModelProviderConfig | null;
  onClose: () => void;
  onSaved: (config: ModelProviderConfig) => void;
  onCleared: () => void;
}) {
  const [form, setForm] = useState<ModelProviderConfigInput>(() =>
    currentConfig
      ? {
          id: currentConfig.id,
          providerType: currentConfig.providerType,
          providerName: currentConfig.providerName,
          baseUrl: currentConfig.baseUrl,
          selectedModel: currentConfig.selectedModel,
          apiKey: ""
        }
      : defaultProviderForm
  );
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [status, setStatus] = useState<ModelProviderConfig | null>(currentConfig);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  function applyPreset(preset: ProviderPreset) {
    setForm((current) => ({
      ...current,
      providerType: preset.providerType,
      providerName: preset.providerName,
      baseUrl: preset.baseUrl,
      selectedModel: preset.providerType === "ollama" ? "" : current.selectedModel
    }));
    setModels([]);
    setError("");
  }

  async function refreshModels() {
    setBusy(true);
    setError("");
    try {
      const nextModels = await listAvailableModels(form);
      setModels(nextModels);
      if (nextModels.length === 0) {
        setError("No models were returned by the provider.");
      } else if (!form.selectedModel) {
        setForm((current) => ({ ...current, selectedModel: nextModels[0]?.name ?? "" }));
      }
    } catch (refreshError) {
      setError(String(refreshError));
    } finally {
      setBusy(false);
    }
  }

  async function validate() {
    setBusy(true);
    setError("");
    try {
      const result = await validateModelProvider(form);
      setStatus(result);
      if (!result.isValid) {
        setError(result.lastValidationError ?? "Provider is invalid.");
      }
    } catch (validationError) {
      setError(String(validationError));
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    setBusy(true);
    setError("");
    try {
      const result = await saveModelProviderConfig(form);
      setStatus(result);
      onSaved(result);
      if (!result.isValid) {
        setError(result.lastValidationError ?? "Provider saved but is invalid.");
      }
    } catch (saveError) {
      setError(String(saveError));
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    setBusy(true);
    try {
      await clearModelProviderConfig();
      setStatus(null);
      setForm(defaultProviderForm);
      setModels([]);
      onCleared();
    } catch (clearError) {
      setError(String(clearError));
    } finally {
      setBusy(false);
    }
  }

  const isOllama = form.providerType === "ollama";

  return (
    <div className="modal-backdrop">
      <div className="settings-modal">
        <div className="modal-title">
          <div>
            <h2>Model Provider Settings</h2>
            <p>Use local Ollama for real coding runs. Recommended models: qwen2.5-coder:7b, llama3:8b, or your saved custom Ollama model.</p>
          </div>
          <button className="frame-icon-button" title="Close" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        <div className="preset-grid">
          {providerPresets.map((preset) => (
            <button key={preset.label} onClick={() => applyPreset(preset)}>
              {preset.label}
            </button>
          ))}
        </div>

        <div className="settings-grid">
          <label>
            Provider type
            <select
              value={form.providerType}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  providerType: event.target.value as ModelProviderType
                }))
              }
            >
              <option value="ollama">Ollama local provider</option>
              <option value="openai_compatible">OpenAI-compatible cloud/private provider</option>
            </select>
          </label>

          <label>
            Provider name
            <input
              value={form.providerName}
              onChange={(event) => setForm((current) => ({ ...current, providerName: event.target.value }))}
            />
          </label>

          <label>
            Base URL
            <input
              value={form.baseUrl}
              onChange={(event) => setForm((current) => ({ ...current, baseUrl: event.target.value }))}
            />
          </label>

          {!isOllama ? (
            <label>
              API key
              <input
                type="password"
                value={form.apiKey ?? ""}
                onChange={(event) => setForm((current) => ({ ...current, apiKey: event.target.value }))}
                placeholder="Stored securely in a future module"
              />
            </label>
          ) : null}

          <label>
            Selected model
            {models.length > 0 ? (
              <select
                value={form.selectedModel}
                onChange={(event) => setForm((current) => ({ ...current, selectedModel: event.target.value }))}
              >
                {models.map((model) => (
                  <option key={model.id} value={model.name}>
                    {model.name}
                  </option>
                ))}
              </select>
            ) : (
              <input
                value={form.selectedModel}
                onChange={(event) => setForm((current) => ({ ...current, selectedModel: event.target.value }))}
                placeholder={isOllama ? "qwen2.5-coder:7b or llama3:8b" : "OpenAI-compatible execution is blocked for now"}
              />
            )}
          </label>
        </div>

        <div className="settings-actions">
          <button onClick={refreshModels} disabled={busy}>
            <RefreshCw size={15} />
            {isOllama ? "Refresh Ollama Models" : "Refresh Models"}
          </button>
          <button onClick={validate} disabled={busy}>
            Validate
          </button>
          <button className="primary-button" onClick={save} disabled={busy}>
            Save
          </button>
          <button className="danger-button" onClick={clear} disabled={busy}>
            <Trash2 size={15} />
            Clear
          </button>
        </div>

        <div className={status?.isValid ? "connection-status valid" : "connection-status invalid"}>
          {status?.isValid ? "Valid" : status ? "Invalid" : "Not configured"}
          {status?.lastValidatedAt ? <span>Last checked: {status.lastValidatedAt}</span> : null}
        </div>
        {error ? <div className="settings-error">{error}</div> : null}
      </div>
    </div>
  );
}
