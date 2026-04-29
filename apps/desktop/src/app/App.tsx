import {
  Bot,
  ChevronDown,
  CircleAlert,
  Code2,
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
  AgentRuntimeSession,
  CommandResult,
  FileEntry,
  GitStatus,
  ModelInfo,
  ModelProviderConfig,
  ModelProviderType,
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
  runRuntimeTurn
} from "../lib/agentRuntime";
import {
  clearModelProviderConfig,
  getGitDiff,
  getGitStatus,
  getModelProviderConfig,
  listAvailableModels,
  listWorkspaceFiles,
  openWorkspace,
  pickWorkspaceDirectory,
  runWorkspaceCommand,
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
    value: "full_access",
    label: "Full access",
    description: "Auto-apply validated patches, then ask before running or opening the result."
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
  const [workspacePath, setWorkspacePath] = useState("");
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);
  const [diffText, setDiffText] = useState("");
  const [terminalCommand, setTerminalCommand] = useState("git status");
  const [terminalResult, setTerminalResult] = useState<CommandResult | null>(null);
  const [prompt, setPrompt] = useState("");
  const [runtimeSession, setRuntimeSession] = useState<AgentRuntimeSession | null>(null);
  const [thinkFirst, setThinkFirst] = useState(false);
  const [accessProfile, setAccessProfile] = useState<AccessProfile>("default_permissions");
  const [accessMenuOpen, setAccessMenuOpen] = useState(false);
  const [safetySettings, setSafetySettings] = useState<SafetySettings>(defaultSafetySettings);
  const [providerConfig, setProviderConfig] = useState<ModelProviderConfig | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [message, setMessage] = useState("Select a workspace and start from the composer.");
  const [agentBusy, setAgentBusy] = useState(false);
  const [queuedPrompts, setQueuedPrompts] = useState<QueuedPrompt[]>([]);
  const [activityOpen, setActivityOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [bottomView, setBottomView] = useState<BottomView>("none");

  useEffect(() => {
    void getModelProviderConfig()
      .then(setProviderConfig)
      .catch(() => setProviderConfig(null));
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

  const sessionTitle = runtimeSession?.agentName ?? "OrchCode";
  const hasSessionView = Boolean(runtimeSession);

  const sessionSummary = runtimeSession
    ? humanSessionStatus(runtimeSession, agentBusy)
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

  async function handleOpenWorkspace() {
    try {
      const nextWorkspace = await openWorkspace(workspacePath.trim());
      setWorkspace(nextWorkspace);
      setMessage(`Workspace open: ${nextWorkspace.name}`);
      await refreshWorkspaceState(nextWorkspace);
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
      setWorkspacePath(selected);
      const nextWorkspace = await openWorkspace(selected);
      setWorkspace(nextWorkspace);
      setMessage(`Workspace open: ${nextWorkspace.name}`);
      await refreshWorkspaceState(nextWorkspace);
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

    setAgentBusy(true);
    setActivityOpen(false);
    setBottomView("none");
    try {
      const sessionId = runtimeSession?.id
        ? runtimeSession.id
        : (
            await createRuntimeSession({
              workspacePath: workspace.path,
              mode: "mock",
              executionMode: "auto_mode",
              accessProfile,
              thinkFirst,
              safetySettings,
              userPrompt: input
            })
          ).sessionId;
      await runRuntimeTurn(sessionId, input);
      const nextSession = await getRuntimeSession(sessionId);
      setRuntimeSession(nextSession);
      setPrompt("");
      await refreshWorkspaceState();
      setMessage(
        queuedMode === "steer"
          ? "Steer request completed."
          : nextSession.nextAction?.message ??
            (nextSession.status === "needs_approval" ? "Session is ready for review." : "Session updated.")
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
      setRuntimeSession(await getRuntimeSession(runtimeSession.id));
    } catch (error) {
      setMessage(String(error));
    }
  }

  async function handleApprovePatch(patchId: string) {
    if (!runtimeSession) return;
    try {
      const result = await approveRuntimePatch(runtimeSession.id, patchId);
      setMessage(result.message);
      await refreshRuntimeSession();
    } catch (error) {
      setMessage(String(error));
    }
  }

  async function handleRejectPatch(patchId: string) {
    if (!runtimeSession) return;
    try {
      const result = await rejectRuntimePatch(runtimeSession.id, patchId);
      setMessage(result.message);
      await refreshRuntimeSession();
    } catch (error) {
      setMessage(String(error));
    }
  }

  async function handleRunSuggestedCommand(command: string) {
    setTerminalCommand(command);
    setBottomView("terminal");
    try {
      const result = await runWorkspaceCommand(command);
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
    setPrompt("");
    setRuntimeSession(null);
    setActivityOpen(false);
    setThinkFirst(false);
    setQueuedPrompts([]);
    setBottomView("none");
    setTerminalResult(null);
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
    setMessage(mode === "steer" ? "Added as steer. It will run next." : "Added to queue. It will run after the current task.");
  }

  function handleOpenPreview() {
    if (!runtimeSession?.previewRecommendation || !workspace) return;
    const preview = runtimeSession.previewRecommendation;
    const target =
      preview.type === "url"
        ? preview.target
        : `file:///${`${workspace.path}\\${preview.target}`.replaceAll("\\", "/")}`;
    window.open(target, "_blank", "noopener,noreferrer");
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
                  <span>{runtimeSession ? humanSessionStatus(runtimeSession, agentBusy) : "Workspace ready"}</span>
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
                  <span>{runtimeSession.lifecycleStage}</span>
                </div>
                <small>{runtimeSession.tasks.length}</small>
              </button>
            ) : null}
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
                onOpenActivity={() => setActivityOpen(true)}
                onQuickReply={submitPrompt}
                onOpenPreview={handleOpenPreview}
              />
            ) : null}

            <div className="composer-shell">
              <textarea
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder="Ask the agent to inspect, plan, explain, or prepare a patch..."
                rows={4}
              />

              <div className="composer-topline">
                <div className="composer-select-row">
                  <button
                    className={providerConfig?.isValid ? "composer-chip valid" : "composer-chip invalid"}
                    onClick={() => setSettingsOpen(true)}
                  >
                    {providerConfig?.isValid ? <ShieldCheck size={14} /> : <CircleAlert size={14} />}
                    <span>{providerConfig?.isValid ? "Provider ready" : "Provider settings"}</span>
                  </button>
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
                  </div>
                  <pre>
                    {terminalResult
                      ? [
                          `$ ${terminalResult.command}`,
                          `risk: ${terminalResult.risk} status: ${terminalResult.status}`,
                          terminalResult.message ?? "",
                          terminalResult.stdout,
                          terminalResult.stderr
                        ]
                          .filter(Boolean)
                          .join("\n")
                      : "Safe commands execute here. Medium commands require approval. Dangerous commands stay blocked."}
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
                  <dd>{runtimeSession.status}</dd>
                  <dt>Stage</dt>
                  <dd>{runtimeSession.lifecycleStage}</dd>
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
                    <span>{proposal.status} | {proposal.riskLevel} risk</span>
                    <p>{proposal.summary}</p>
                    <div className="proposal-actions">
                      <button onClick={() => handleApprovePatch(proposal.id)} disabled={proposal.status !== "proposed"}>
                        Approve
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
                    <span>{request.risk} | {request.status}</span>
                    <p>{request.reason}</p>
                    <button
                      onClick={() => handleRunSuggestedCommand(request.command)}
                      disabled={request.risk !== "safe" || request.status === "blocked"}
                    >
                      Run safe command
                    </button>
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
  onOpenActivity,
  onQuickReply,
  onOpenPreview
}: {
  session: AgentRuntimeSession;
  onOpenActivity: () => void;
  onQuickReply: (message: string) => void | Promise<void>;
  onOpenPreview: () => void;
}) {
  const latestPatch = session.patchProposals[0];
  const latestCommand = session.commandRequests.at(-1);

  return (
    <div className="thread-feed">
      {session.messages.map((message) => (
        <div key={message.id} className={`thread-entry ${message.role}`}>
          <div className="thread-entry-label">{message.role === "user" ? "You" : message.role === "assistant" ? session.agentName : "System"}</div>
          <div className="thread-entry-body">{message.content}</div>
        </div>
      ))}

      {session.delegationDecision ? (
        <CompactNote
          title="How I handled it"
          action={
            <button className="activity-link" onClick={onOpenActivity}>
              Details
            </button>
          }
        >
          {session.delegationDecision.rationale}
        </CompactNote>
      ) : null}

      {session.status === "running" ? <CompactNote title="Working">{session.reasoningSummaries.at(-1) ?? "The agent is working on your request."}</CompactNote> : null}

      {latestPatch ? <CompactNote title="Changes ready">{latestPatch.summary}</CompactNote> : null}

      {latestCommand ? <CompactNote title="Suggested action">{latestCommand.reason}</CompactNote> : null}

      {session.nextAction?.kind === "confirm_plan" ? (
        <ActionCard
          title="Plan ready"
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
          title="Done"
          message={session.nextAction.message}
          actions={
            <>
              <button onClick={() => void onQuickReply("Run it now.")}>Run it now</button>
              <button onClick={() => void onQuickReply("Show me the results first.")}>Show results</button>
            </>
          }
        />
      ) : null}

      {session.nextAction?.kind === "preview_ready" ? (
        <ActionCard
          title="Preview ready"
          message={session.nextAction.message}
          actions={
            <button onClick={onOpenPreview}>
              <Globe size={14} />
              Open preview
            </button>
          }
        />
      ) : null}
    </div>
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
  return (
    <div className="status-row">
      <Bot size={15} className={status === "done" || status === "completed" ? "done-icon" : "pending-icon"} />
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

function accessProfileLabel(profile: AccessProfile) {
  return accessOptions.find((option) => option.value === profile)?.label ?? "Default permissions";
}

function humanSessionStatus(session: AgentRuntimeSession | null, agentBusy = false) {
  if (!session) return "Open a workspace to begin";
  if (agentBusy) return "Working on your request";

  switch (session.nextAction?.kind) {
    case "confirm_plan":
      return "Plan ready";
    case "confirm_preview":
      return "Done. Ready to run";
    case "preview_ready":
      return "Preview ready";
    default:
      break;
  }

  if (session.status === "needs_approval") return "Ready for review";
  if (session.status === "completed") return "Done";
  if (session.status === "running") return "Working on your request";
  if (session.status === "failed") return "Run failed";
  return "Session active";
}

function summarizeLatestQueueEntry(entry: QueuedPrompt | undefined) {
  if (!entry) return "";
  const compact = entry.text.replace(/\s+/g, " ").trim();
  return compact.length > 58 ? `${compact.slice(0, 58)}...` : compact;
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
            <p>Validate a provider before real LLM sessions. Mock mode runs locally without API keys.</p>
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
                placeholder={isOllama ? "Refresh Ollama models" : "model id"}
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
