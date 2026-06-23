import {
  Bot,
  ChevronRight,
  GitBranch,
  Maximize2,
  MessageSquarePlus,
  Search,
  Workflow,
  X,
  ZoomIn,
  ZoomOut
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type {
  AgentRuntimeSession,
  AgentRuntimeSwarmMessage,
  AgentRuntimeSwarmNode,
  AgentRuntimeSwarmNodeStatus,
  AgentRuntimeSwarmState
} from "@hivo/protocol";
import { sendRuntimeAgentMessage } from "../lib/agentRuntime";

type SwarmDockProps = {
  session: AgentRuntimeSession | null;
  sessionToken: string;
  onSessionUpdate: (session: AgentRuntimeSession) => void;
  onSelectAgent?: (agentId: string) => void;
};

type LayoutNode = {
  id: string;
  sourceId: string;
  node: AgentRuntimeSwarmNode;
  x: number;
  y: number;
  angle: number;
  radius: number;
  depth: number;
  labelSide: "center" | "left" | "right";
  hasChildren: boolean;
  collapsed: boolean;
  order: number;
};

type LayoutEdge = {
  fromId: string;
  toId: string;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  fromAngle: number;
  toAngle: number;
  fromRadius: number;
  toRadius: number;
  status: AgentRuntimeSwarmNodeStatus;
};

type SwarmLayout = {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  width: number;
  height: number;
  centerX: number;
  centerY: number;
  rings: number[];
  outerRadius: number;
};

type Viewport = { x: number; y: number; w: number; h: number };

const STATUS_LABELS: Record<AgentRuntimeSwarmNodeStatus, string> = {
  idle: "Idle",
  queued: "Queued",
  running: "Running",
  completed: "Done",
  blocked: "Blocked",
  failed: "Failed"
};

const STATUS_COLORS: Record<AgentRuntimeSwarmNodeStatus, string> = {
  idle: "#8f8f8f",
  queued: "#e7c85b",
  running: "#49b6e5",
  completed: "#22c55e",
  blocked: "#f59e0b",
  failed: "#ef4444"
};

const ZOOM_MIN = 0.32;
const ZOOM_MAX = 1.7;
const RADIAL_MARGIN = 180;

export function SwarmDock({ session, sessionToken, onSessionUpdate, onSelectAgent }: SwarmDockProps) {
  const swarm = session?.swarmState;
  const [open, setOpen] = useState(false);
  const totalAgents = Math.max(0, swarm?.effectiveTotalLogicalAgents ?? 0);
  const running = swarm?.activeAgentCount ?? 0;
  const blocked = (swarm?.statusCounts.blocked ?? 0) + (swarm?.statusCounts.failed ?? 0);

  if (!swarm || swarm.nodes.length <= 1 || totalAgents <= 0) return null;

  return (
    <>
      <button
        className={`swarm-dock-chip ${open ? "active-toggle" : ""}`}
        onClick={() => setOpen(true)}
        type="button"
        title="Open swarm dock"
      >
        <span className="swarm-chip-mark">
          <Workflow size={15} />
        </span>
        <span className="swarm-chip-copy">
          <strong>{totalAgents} agents</strong>
          <small>{running} active{blocked ? ` | ${blocked} needs review` : ""}</small>
        </span>
        <ChevronRight size={14} />
      </button>
      {open ? (
        <SwarmDockModal
          session={session}
          swarm={swarm}
          sessionToken={sessionToken}
          onClose={() => setOpen(false)}
          onSessionUpdate={onSessionUpdate}
          onSelectAgent={onSelectAgent}
        />
      ) : null}
    </>
  );
}

function SwarmDockModal({
  session,
  swarm,
  sessionToken,
  onClose,
  onSessionUpdate,
  onSelectAgent
}: {
  session: AgentRuntimeSession;
  swarm: AgentRuntimeSwarmState;
  sessionToken: string;
  onClose: () => void;
  onSessionUpdate: (session: AgentRuntimeSession) => void;
  onSelectAgent?: (agentId: string) => void;
}) {
  const [selectedId, setSelectedId] = useState(swarm.rootId);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [zoom, setZoom] = useState(0.78);
  const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, w: 0, h: 0 });
  const [statusFilter, setStatusFilter] = useState<AgentRuntimeSwarmNodeStatus | "all">("all");
  const [query, setQuery] = useState("");
  const [animationRun, setAnimationRun] = useState(0);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const initialFitRef = useRef(false);

  const layout = useMemo(
    () => layoutSwarm(swarm, collapsed, query, statusFilter),
    [swarm, collapsed, query, statusFilter]
  );
  const selected = layout.nodes.find((node) => node.sourceId === selectedId)?.node
    ?? swarm.nodes.find((node) => node.id === selectedId)
    ?? swarm.nodes[0];
  const activeId = hoverId ?? selectedId;
  const pathIds = useMemo(() => computePathIds(layout, activeId), [layout, activeId]);

  const updateViewport = useCallback(() => {
    const element = scrollerRef.current;
    if (!element) return;
    setViewport({
      x: element.scrollLeft / zoom,
      y: element.scrollTop / zoom,
      w: element.clientWidth / zoom,
      h: element.clientHeight / zoom
    });
  }, [zoom]);

  useEffect(() => {
    updateViewport();
    const element = scrollerRef.current;
    if (!element) return;
    const observer = new ResizeObserver(updateViewport);
    observer.observe(element);
    element.addEventListener("scroll", updateViewport, { passive: true });
    return () => {
      observer.disconnect();
      element.removeEventListener("scroll", updateViewport);
    };
  }, [updateViewport]);

  useEffect(() => {
    updateViewport();
  }, [layout.width, layout.height, updateViewport]);

  useEffect(() => {
    if (layout.nodes.some((node) => node.sourceId === selectedId)) return;
    setSelectedId(layout.nodes[0]?.sourceId ?? swarm.rootId);
  }, [layout.nodes, selectedId, swarm.rootId]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const tag = (event.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      } else if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        setZoom((current) => clampZoom(current + 0.12));
      } else if (event.key === "-" || event.key === "_") {
        event.preventDefault();
        setZoom((current) => clampZoom(current - 0.12));
      } else if (event.key === "ArrowRight" || event.key === "ArrowDown") {
        event.preventDefault();
        setSelectedId(nextVisibleNodeId(layout.nodes, selectedId, 1));
      } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
        event.preventDefault();
        setSelectedId(nextVisibleNodeId(layout.nodes, selectedId, -1));
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [layout.nodes, onClose, selectedId]);

  const fitToScreen = useCallback(() => {
    const element = scrollerRef.current;
    if (!element) return;
    const nextZoom = clampZoom(Math.min(element.clientWidth / Math.max(layout.width + 32, 1), element.clientHeight / Math.max(layout.height + 32, 1)));
    setZoom(nextZoom);
    window.setTimeout(() => {
      element.scrollLeft = Math.max(0, layout.centerX * nextZoom - element.clientWidth / 2);
      element.scrollTop = Math.max(0, layout.centerY * nextZoom - element.clientHeight / 2);
      updateViewport();
    }, 0);
  }, [layout.centerX, layout.centerY, layout.height, layout.width, updateViewport]);

  useEffect(() => {
    if (initialFitRef.current || !layout.nodes.length) return;
    initialFitRef.current = true;
    window.setTimeout(fitToScreen, 0);
  }, [fitToScreen, layout.nodes.length]);

  const toggleCollapse = useCallback((nodeId: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
  }, []);

  return (
    <div className="swarm-modal-backdrop">
      <section className="swarm-modal" aria-label="Swarm dock">
        <header className="swarm-modal-header">
          <div>
            <strong>Swarm dock</strong>
            <span>
              {swarm.effectiveTotalLogicalAgents} logical agents | {swarm.maxSupportedLogicalAgents} capacity | {swarm.source.replaceAll("_", " ")}
              {swarm.swarmRunId ? ` | ${swarm.swarmRunId}` : ""}
            </span>
          </div>
          <div className="swarm-modal-actions">
            <button className="swarm-utility-button" onClick={() => setAnimationRun((current) => current + 1)} type="button">
              Replay
            </button>
            <div className="swarm-search">
              <Search size={14} />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find agent, work item, file" />
            </div>
            <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as AgentRuntimeSwarmNodeStatus | "all")}>
              <option value="all">All status</option>
              {Object.entries(STATUS_LABELS).map(([status, label]) => (
                <option key={status} value={status}>{label}</option>
              ))}
            </select>
            <button className="frame-icon-button" onClick={() => setZoom((current) => clampZoom(current - 0.12))} title="Zoom out" type="button">
              <ZoomOut size={15} />
            </button>
            <button className="frame-icon-button" onClick={() => setZoom((current) => clampZoom(current + 0.12))} title="Zoom in" type="button">
              <ZoomIn size={15} />
            </button>
            <button className="frame-icon-button" onClick={fitToScreen} title="Fit graph" type="button">
              <Maximize2 size={15} />
            </button>
            <button className="frame-icon-button" onClick={onClose} title="Close swarm dock" type="button">
              <X size={16} />
            </button>
          </div>
        </header>

        <div className="swarm-status-strip">
          {Object.entries(STATUS_LABELS).map(([status, label]) => (
            <button
              key={status}
              className={`swarm-status-pill ${statusFilter === status ? "selected" : ""}`}
              onClick={() => setStatusFilter((current) => current === status ? "all" : status as AgentRuntimeSwarmNodeStatus)}
              style={{ "--swarm-status-color": STATUS_COLORS[status as AgentRuntimeSwarmNodeStatus] } as CSSProperties}
              type="button"
            >
              <span />
              {label}
              <strong>{swarm.statusCounts[status as AgentRuntimeSwarmNodeStatus]}</strong>
            </button>
          ))}
        </div>

        <div className="swarm-modal-body">
          <div className="swarm-graph-shell">
            <div className="swarm-graph-label top">Groups</div>
            <div className="swarm-graph-label bottom">Agents / work items</div>
            <div ref={scrollerRef} className="swarm-graph-scroll">
              <div className="swarm-graph-stage" style={{ width: layout.width * zoom, height: layout.height * zoom }}>
                <div className="swarm-graph-world" style={{ width: layout.width, height: layout.height, transform: `scale(${zoom})` }}>
                  <SwarmEdgeCanvas layout={layout} viewport={viewport} selectedId={selectedId} hoverId={hoverId} pathIds={pathIds} zoom={zoom} />
                  {layout.nodes
                    .filter((node) => isNodeVisible(node, viewport))
                    .map((node) => (
                      <SwarmRadialNode
                        key={`${animationRun}:${node.id}`}
                        layoutNode={node}
                        selected={selectedId === node.sourceId}
                        onSelect={() => {
                          setSelectedId(node.sourceId);
                          if (isMessageableNode(node.node)) onSelectAgent?.(node.sourceId);
                        }}
                        onHover={setHoverId}
                        onToggleCollapse={toggleCollapse}
                        onPath={pathIds.has(node.id)}
                        zoom={zoom}
                      />
                    ))}
                </div>
              </div>
            </div>
            <SwarmMinimap layout={layout} viewport={viewport} pathIds={pathIds} onJump={(x, y) => {
              const element = scrollerRef.current;
              if (!element) return;
              element.scrollLeft = Math.max(0, x * zoom - element.clientWidth / 2);
              element.scrollTop = Math.max(0, y * zoom - element.clientHeight / 2);
              updateViewport();
            }} />
          </div>

          <SwarmAgentInspector
            session={session}
            node={selected}
            swarm={swarm}
            sessionToken={sessionToken}
            onSessionUpdate={onSessionUpdate}
          />
        </div>
      </section>
    </div>
  );
}

function SwarmEdgeCanvas({
  layout,
  viewport,
  selectedId,
  hoverId,
  pathIds,
  zoom
}: {
  layout: SwarmLayout;
  viewport: Viewport;
  selectedId: string;
  hoverId: string | null;
  pathIds: Set<string>;
  zoom: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stateRef = useRef({ layout, viewport, selectedId, hoverId, pathIds, zoom });
  stateRef.current = { layout, viewport, selectedId, hoverId, pathIds, zoom };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.floor(layout.width * dpr));
    canvas.height = Math.max(1, Math.floor(layout.height * dpr));
    canvas.style.width = `${layout.width}px`;
    canvas.style.height = `${layout.height}px`;
    const context = canvas.getContext("2d", { alpha: true });
    if (!context) return;
    let frame = 0;
    let animation = 0;
    const startedAt = performance.now();
    const prefersReduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

    const draw = (time: number) => {
      const current = stateRef.current;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.clearRect(0, 0, current.layout.width, current.layout.height);
      drawRadialGrid(context, current.layout);
      const elapsed = (time - startedAt) / 1000;
      for (const edge of current.layout.edges) {
        if (!isEdgeVisible(edge, current.viewport)) continue;
        const onPath = current.pathIds.has(edge.fromId) && current.pathIds.has(edge.toId);
        const dimmed = (current.selectedId || current.hoverId) && !onPath;
        const color = STATUS_COLORS[edge.status];
        const controls = radialControls(current.layout, edge);
        context.lineCap = "round";
        context.strokeStyle = withAlpha(color, onPath ? 0.74 : dimmed ? 0.08 : 0.24);
        context.lineWidth = onPath ? 2.1 : 1.15;
        context.beginPath();
        context.moveTo(edge.fromX, edge.fromY);
        context.bezierCurveTo(controls.c1.x, controls.c1.y, controls.c2.x, controls.c2.y, edge.toX, edge.toY);
        context.stroke();
        if (!prefersReduced && !dimmed && current.zoom > 0.44 && frame % 2 === 0) {
          const phase = (elapsed * 0.42 + edge.toRadius / Math.max(current.layout.outerRadius, 1)) % 1;
          const point = sampleBezier(edge.fromX, edge.fromY, controls.c1.x, controls.c1.y, controls.c2.x, controls.c2.y, edge.toX, edge.toY, phase);
          context.fillStyle = withAlpha(color, onPath ? 0.9 : 0.48);
          context.beginPath();
          context.arc(point.x, point.y, onPath ? 3.2 : 2.2, 0, Math.PI * 2);
          context.fill();
        }
      }
      frame += 1;
      animation = requestAnimationFrame(draw);
    };
    animation = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(animation);
  }, [layout.height, layout.width]);

  return <canvas ref={canvasRef} className="swarm-edge-canvas" aria-hidden="true" />;
}

const SwarmRadialNode = memo(function SwarmRadialNode({
  layoutNode,
  selected,
  onSelect,
  onHover,
  onToggleCollapse,
  onPath,
  zoom
}: {
  layoutNode: LayoutNode;
  selected: boolean;
  onSelect: () => void;
  onHover: (id: string | null) => void;
  onToggleCollapse: (id: string) => void;
  onPath: boolean;
  zoom: number;
}) {
  const { node } = layoutNode;
  const lowDetail = zoom < 0.62 && layoutNode.depth > 1;
  const style = {
    left: layoutNode.x,
    top: layoutNode.y,
    "--swarm-node-color": STATUS_COLORS[node.status],
    "--swarm-node-delay": `${Math.min(layoutNode.order * 18, 900)}ms`
  } as CSSProperties;
  const icon = iconForNode(node);
  if (lowDetail) {
    return (
      <button
        className={`swarm-node-dot ${node.kind} ${selected ? "selected" : ""} ${onPath ? "on-path" : ""}`}
        style={style}
        onClick={onSelect}
        onMouseEnter={() => onHover(layoutNode.sourceId)}
        onMouseLeave={() => onHover(null)}
        title={`${node.name} | ${node.role} | ${STATUS_LABELS[node.status]}`}
        type="button"
      />
    );
  }
  return (
    <button
      className={`swarm-radial-node ${node.kind} ${layoutNode.labelSide} ${selected ? "selected" : ""} ${onPath ? "on-path" : ""}`}
      style={style}
      onClick={onSelect}
      onMouseEnter={() => onHover(layoutNode.sourceId)}
      onMouseLeave={() => onHover(null)}
      title={`${node.name} | ${node.role} | ${node.objective}`}
      type="button"
    >
      <span className="swarm-node-avatar">{icon}</span>
      <span className="swarm-node-main">
        <strong>{node.name}</strong>
        <small>{node.role}</small>
      </span>
      {layoutNode.hasChildren ? (
        <span
          className="swarm-collapse-hit"
          onClick={(event) => {
            event.stopPropagation();
            onToggleCollapse(layoutNode.sourceId);
          }}
          title={layoutNode.collapsed ? "Expand" : "Collapse"}
        >
          {layoutNode.collapsed ? "+" : "-"}
        </span>
      ) : null}
    </button>
  );
});

function SwarmAgentInspector({
  session,
  node,
  swarm,
  sessionToken,
  onSessionUpdate
}: {
  session: AgentRuntimeSession;
  node?: AgentRuntimeSwarmNode;
  swarm: AgentRuntimeSwarmState;
  sessionToken: string;
  onSessionUpdate: (session: AgentRuntimeSession) => void;
}) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const canMessage = Boolean(node && isMessageableNode(node));
  const messages = useMemo(
    () => node && canMessage ? swarm.messages.filter((message) => message.agentId === node.id).slice(-20) : [],
    [canMessage, node, swarm.messages]
  );
  const stats = useMemo(() => node ? inspectNodeStats(swarm, node.id) : undefined, [node, swarm]);

  useEffect(() => {
    setDraft("");
    setError("");
  }, [node?.id]);

  if (!node) {
    return (
      <aside className="swarm-agent-inspector">
        <strong>No node selected</strong>
      </aside>
    );
  }
  const selectedNode = node;

  async function sendMessage() {
    const text = draft.trim();
    if (!text || busy || !canMessage) return;
    setBusy(true);
    setError("");
    try {
      const response = await sendRuntimeAgentMessage(session.id, selectedNode.id, text, sessionToken);
      onSessionUpdate(response.session);
      setDraft("");
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : String(sendError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside className="swarm-agent-inspector">
      <div className="swarm-agent-title">
        <span style={{ "--swarm-node-color": STATUS_COLORS[node.status] } as CSSProperties} />
        <div>
          <strong>{node.name}</strong>
          <small>{node.role} | {node.kind.replaceAll("_", " ")} | {STATUS_LABELS[node.status]}</small>
        </div>
      </div>
      <div className="swarm-agent-summary">
        <strong>Objective</strong>
        <span>{node.objective}</span>
      </div>
      <div className="swarm-agent-grid">
        <div><strong>Action</strong><span>{node.currentAction ?? "Not reported yet."}</span></div>
        <div><strong>Summary</strong><span>{node.summary ?? node.output ?? "Not reported yet."}</span></div>
        <div><strong>Children</strong><span>{stats ? `${stats.directChildren} direct | ${stats.agentCount} agent(s) | ${stats.workItemCount} work item(s)` : "None"}</span></div>
        <div><strong>Work items</strong><span>{node.workItemRefs.length ? node.workItemRefs.slice(0, 8).join(", ") : "None"}</span></div>
        <div><strong>Artifacts</strong><span>{node.artifactRefs.length ? node.artifactRefs.slice(0, 8).join(", ") : "None"}</span></div>
        <div><strong>Target files</strong><span>{node.targetFiles.length ? node.targetFiles.slice(0, 8).join(", ") : "None"}</span></div>
        <div><strong>Changed files</strong><span>{node.changedFiles.length ? node.changedFiles.slice(0, 8).join(", ") : "None"}</span></div>
      </div>

      {canMessage ? (
        <section className="swarm-agent-chat">
          <div className="swarm-agent-chat-header">
            <strong>Scoped steer</strong>
            <small>{node.status === "running" || node.status === "queued" ? "Recorded for the next safe runtime step" : "Read-only provider answer from recorded context"}</small>
          </div>
          <div className="swarm-agent-messages">
            {messages.length ? messages.map((message) => (
              <SwarmMessageBubble key={message.id} message={message} />
            )) : (
              <span className="swarm-agent-empty">No scoped messages yet.</span>
            )}
          </div>
          <div className="swarm-agent-composer">
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder={`Message ${node.name}`}
            />
            <button className="send-button has-draft" onClick={sendMessage} disabled={!draft.trim() || busy} title="Send scoped steer" type="button">
              <MessageSquarePlus size={15} />
            </button>
          </div>
          {error ? <div className="swarm-agent-error">{error}</div> : null}
        </section>
      ) : (
        <section className="swarm-agent-chat compact">
          <div className="swarm-agent-chat-header">
            <strong>Runtime record</strong>
            <small>This node summarizes persisted runtime state; select a real agent node to send a scoped steer.</small>
          </div>
        </section>
      )}
    </aside>
  );
}

function SwarmMessageBubble({ message }: { message: AgentRuntimeSwarmMessage }) {
  return (
    <div className={`swarm-message-bubble ${message.role}`}>
      <strong>{message.role === "user" ? "You" : message.role === "agent" ? "Agent" : "System"}</strong>
      <span>{message.content}</span>
      {message.error ? <small>{message.error}</small> : null}
    </div>
  );
}

function SwarmMinimap({
  layout,
  viewport,
  pathIds,
  onJump
}: {
  layout: SwarmLayout;
  viewport: Viewport;
  pathIds: Set<string>;
  onJump: (x: number, y: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const width = 172;
    const height = 110;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, height);
    const scale = Math.min(width / Math.max(layout.width, 1), height / Math.max(layout.height, 1));
    const offsetX = (width - layout.width * scale) / 2;
    const offsetY = (height - layout.height * scale) / 2;
    context.strokeStyle = "rgba(255,255,255,0.12)";
    for (const ring of layout.rings) {
      context.beginPath();
      context.arc(offsetX + layout.centerX * scale, offsetY + layout.centerY * scale, ring * scale, 0, Math.PI * 2);
      context.stroke();
    }
    for (const edge of layout.edges) {
      context.strokeStyle = pathIds.has(edge.fromId) && pathIds.has(edge.toId) ? "rgba(73,182,229,0.72)" : "rgba(255,255,255,0.08)";
      context.beginPath();
      context.moveTo(offsetX + edge.fromX * scale, offsetY + edge.fromY * scale);
      context.lineTo(offsetX + edge.toX * scale, offsetY + edge.toY * scale);
      context.stroke();
    }
    for (const node of layout.nodes) {
      context.fillStyle = STATUS_COLORS[node.node.status];
      context.globalAlpha = pathIds.has(node.id) ? 1 : 0.48;
      context.beginPath();
      context.arc(offsetX + node.x * scale, offsetY + node.y * scale, pathIds.has(node.id) ? 2.6 : 1.8, 0, Math.PI * 2);
      context.fill();
    }
    context.globalAlpha = 1;
    context.strokeStyle = "rgba(245,245,245,0.7)";
    context.strokeRect(offsetX + viewport.x * scale, offsetY + viewport.y * scale, Math.max(8, viewport.w * scale), Math.max(8, viewport.h * scale));
  }, [layout, pathIds, viewport]);

  return (
    <canvas
      ref={canvasRef}
      className="swarm-minimap"
      width={172}
      height={110}
      onClick={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        const scale = Math.min(172 / Math.max(layout.width, 1), 110 / Math.max(layout.height, 1));
        const offsetX = (172 - layout.width * scale) / 2;
        const offsetY = (110 - layout.height * scale) / 2;
        onJump((event.clientX - rect.left - offsetX) / scale, (event.clientY - rect.top - offsetY) / scale);
      }}
    />
  );
}

function layoutSwarm(
  swarm: AgentRuntimeSwarmState,
  collapsed: Set<string>,
  query: string,
  statusFilter: AgentRuntimeSwarmNodeStatus | "all"
): SwarmLayout {
  const root = swarm.nodes.find((node) => node.id === swarm.rootId) ?? swarm.nodes[0];
  if (!root) return { nodes: [], edges: [], width: 720, height: 520, centerX: 360, centerY: 260, rings: [], outerRadius: 0 };
  const visibleSourceNodes = filterSourceNodes(swarm.nodes, root.id, query, statusFilter);
  const visibleIds = new Set(visibleSourceNodes.map((node) => node.id));
  const byParent = new Map<string, AgentRuntimeSwarmNode[]>();
  for (const node of visibleSourceNodes) {
    if (node.id === root.id) continue;
    const parentId = node.parentId && visibleIds.has(node.parentId) ? node.parentId : root.id;
    const children = byParent.get(parentId) ?? [];
    children.push(node);
    byParent.set(parentId, children);
  }
  for (const children of byParent.values()) {
    children.sort(compareSwarmNodes);
  }

  const leafCount = (node: AgentRuntimeSwarmNode): number => {
    const children = byParent.get(node.id) ?? [];
    if (!children.length || collapsed.has(node.id)) return 1;
    return children.reduce((sum, child) => sum + leafCount(child), 0);
  };

  const maxDepthFor = (node: AgentRuntimeSwarmNode, depth: number): number => {
    const children = byParent.get(node.id) ?? [];
    if (!children.length || collapsed.has(node.id)) return depth;
    return Math.max(depth, ...children.map((child) => maxDepthFor(child, depth + 1)));
  };

  const leafTotal = Math.max(leafCount(root), 1);
  const maxDepth = Math.max(1, maxDepthFor(root, 0));
  const ringGap = clamp(leafTotal > 140 ? 228 : leafTotal > 60 ? 202 : 148, 128, 232);
  const outerRadius = Math.max(320, ringGap * maxDepth);
  const width = Math.ceil(outerRadius * 2 + RADIAL_MARGIN * 2);
  const height = width;
  const centerX = width / 2;
  const centerY = height / 2;
  const rings = Array.from({ length: maxDepth }, (_, index) => (index + 1) * ringGap);
  const nodes: LayoutNode[] = [];
  const positions = new Map<string, LayoutNode>();
  let order = 0;

  const assign = (node: AgentRuntimeSwarmNode, depth: number, startAngle: number, endAngle: number) => {
    const angle = depth === 0 ? -90 : (startAngle + endAngle) / 2;
    const radius = depth * ringGap;
    const point = polarPoint(centerX, centerY, angle, radius);
    const normalized = normalizeAngle(angle);
    const layoutNode: LayoutNode = {
      id: node.id,
      sourceId: node.id,
      node,
      x: point.x,
      y: point.y,
      angle,
      radius,
      depth,
      labelSide: depth === 0 ? "center" : normalized > 90 && normalized < 270 ? "left" : "right",
      hasChildren: (byParent.get(node.id) ?? []).length > 0,
      collapsed: collapsed.has(node.id),
      order: order++
    };
    nodes.push(layoutNode);
    positions.set(node.id, layoutNode);
    const children = byParent.get(node.id) ?? [];
    if (!children.length || collapsed.has(node.id)) return;
    const total = children.reduce((sum, child) => sum + leafCount(child), 0);
    let cursor = startAngle;
    for (const child of children) {
      const span = (endAngle - startAngle) * (leafCount(child) / Math.max(total, 1));
      assign(child, depth + 1, cursor, cursor + span);
      cursor += span;
    }
  };

  assign(root, 0, -90, 270);

  const edges: LayoutEdge[] = [];
  for (const node of nodes) {
    if (node.collapsed) continue;
    const children = byParent.get(node.sourceId) ?? [];
    for (const child of children) {
      const childPosition = positions.get(child.id);
      if (!childPosition) continue;
      edges.push({
        fromId: node.id,
        toId: childPosition.id,
        fromX: node.x,
        fromY: node.y,
        toX: childPosition.x,
        toY: childPosition.y,
        fromAngle: node.angle,
        toAngle: childPosition.angle,
        fromRadius: node.radius,
        toRadius: childPosition.radius,
        status: child.status
      });
    }
  }

  return { nodes, edges, width, height, centerX, centerY, rings, outerRadius };
}

function filterSourceNodes(
  nodes: AgentRuntimeSwarmNode[],
  rootId: string,
  query: string,
  statusFilter: AgentRuntimeSwarmNodeStatus | "all"
) {
  const normalized = query.trim().toLowerCase();
  if (!normalized && statusFilter === "all") return nodes;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const keep = new Set<string>([rootId]);
  for (const node of nodes) {
    const statusMatches = statusFilter === "all" || node.status === statusFilter;
    const textMatches = !normalized || [
      node.name,
      node.role,
      node.kind,
      node.objective,
      node.currentAction ?? "",
      node.summary ?? "",
      ...node.targetFiles,
      ...node.artifactRefs,
      ...node.workItemRefs
    ].join(" ").toLowerCase().includes(normalized);
    if (!statusMatches || !textMatches) continue;
    let current: AgentRuntimeSwarmNode | undefined = node;
    while (current) {
      keep.add(current.id);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
  }
  return nodes.filter((node) => keep.has(node.id));
}

function computePathIds(layout: SwarmLayout, sourceId: string) {
  const path = new Set<string>();
  if (!layout.nodes.some((node) => node.sourceId === sourceId)) return path;
  const childMap = new Map<string, string[]>();
  const parentMap = new Map<string, string>();
  for (const edge of layout.edges) {
    parentMap.set(edge.toId, edge.fromId);
    const list = childMap.get(edge.fromId) ?? [];
    list.push(edge.toId);
    childMap.set(edge.fromId, list);
  }
  let current: string | undefined = sourceId;
  while (current) {
    path.add(current);
    current = parentMap.get(current);
  }
  const stack = [sourceId];
  while (stack.length) {
    const id = stack.pop();
    if (!id) continue;
    path.add(id);
    stack.push(...(childMap.get(id) ?? []));
  }
  return path;
}

function inspectNodeStats(swarm: AgentRuntimeSwarmState, nodeId: string) {
  const childMap = new Map<string, AgentRuntimeSwarmNode[]>();
  for (const node of swarm.nodes) {
    if (!node.parentId) continue;
    const list = childMap.get(node.parentId) ?? [];
    list.push(node);
    childMap.set(node.parentId, list);
  }
  const directChildren = childMap.get(nodeId)?.length ?? 0;
  const descendants: AgentRuntimeSwarmNode[] = [];
  const stack = [...(childMap.get(nodeId) ?? [])];
  while (stack.length) {
    const node = stack.pop();
    if (!node) continue;
    descendants.push(node);
    stack.push(...(childMap.get(node.id) ?? []));
  }
  return {
    directChildren,
    agentCount: descendants.filter(isMessageableNode).length,
    workItemCount: descendants.filter((node) => node.kind === "work_item").length
  };
}

function compareSwarmNodes(left: AgentRuntimeSwarmNode, right: AgentRuntimeSwarmNode) {
  return kindRank(left.kind) - kindRank(right.kind)
    || statusRank(left.status) - statusRank(right.status)
    || left.role.localeCompare(right.role)
    || left.name.localeCompare(right.name)
    || left.id.localeCompare(right.id);
}

function kindRank(kind: AgentRuntimeSwarmNode["kind"]) {
  if (kind === "group") return 0;
  if (kind === "coordinator") return 1;
  if (kind === "specialist") return 2;
  if (kind === "worker") return 3;
  if (kind === "work_item") return 4;
  if (kind === "gate") return 5;
  if (kind === "aggregator") return 6;
  return 7;
}

function statusRank(status: AgentRuntimeSwarmNodeStatus) {
  if (status === "failed") return 0;
  if (status === "blocked") return 1;
  if (status === "running") return 2;
  if (status === "queued") return 3;
  if (status === "idle") return 4;
  return 5;
}

function isMessageableNode(node: AgentRuntimeSwarmNode) {
  return node.kind === "worker" || node.kind === "specialist" || node.kind === "coordinator" || node.kind === "aggregator";
}

function iconForNode(node: AgentRuntimeSwarmNode) {
  if (node.kind === "group") return <Workflow size={13} />;
  if (node.kind === "work_item" || node.kind === "gate") return <GitBranch size={13} />;
  return <Bot size={13} />;
}

function drawRadialGrid(context: CanvasRenderingContext2D, layout: SwarmLayout) {
  context.save();
  context.strokeStyle = "rgba(255,255,255,0.055)";
  context.lineWidth = 1;
  for (const ring of layout.rings) {
    context.beginPath();
    context.arc(layout.centerX, layout.centerY, ring, 0, Math.PI * 2);
    context.stroke();
  }
  context.strokeStyle = "rgba(73,182,229,0.08)";
  for (let angle = 0; angle < 360; angle += 15) {
    const inner = polarPoint(layout.centerX, layout.centerY, angle, Math.max(52, layout.rings[0] ?? 72));
    const outer = polarPoint(layout.centerX, layout.centerY, angle, layout.outerRadius + 18);
    context.beginPath();
    context.moveTo(inner.x, inner.y);
    context.lineTo(outer.x, outer.y);
    context.stroke();
  }
  context.restore();
}

function radialControls(layout: SwarmLayout, edge: LayoutEdge) {
  const midRadius = (edge.fromRadius + edge.toRadius) / 2;
  return {
    c1: polarPoint(layout.centerX, layout.centerY, edge.fromAngle, midRadius),
    c2: polarPoint(layout.centerX, layout.centerY, edge.toAngle, midRadius)
  };
}

function polarPoint(centerX: number, centerY: number, angleDeg: number, radius: number) {
  const radians = angleDeg * Math.PI / 180;
  return {
    x: centerX + Math.cos(radians) * radius,
    y: centerY + Math.sin(radians) * radius
  };
}

function normalizeAngle(angle: number) {
  return ((angle % 360) + 360) % 360;
}

function isNodeVisible(node: LayoutNode, viewport: Viewport) {
  if (!viewport.w || !viewport.h) return true;
  return node.x >= viewport.x - 220
    && node.x <= viewport.x + viewport.w + 220
    && node.y >= viewport.y - 180
    && node.y <= viewport.y + viewport.h + 180;
}

function isEdgeVisible(edge: LayoutEdge, viewport: Viewport) {
  if (!viewport.w || !viewport.h) return true;
  const minX = Math.min(edge.fromX, edge.toX);
  const maxX = Math.max(edge.fromX, edge.toX);
  const minY = Math.min(edge.fromY, edge.toY);
  const maxY = Math.max(edge.fromY, edge.toY);
  return maxX >= viewport.x - 180
    && minX <= viewport.x + viewport.w + 180
    && maxY >= viewport.y - 180
    && minY <= viewport.y + viewport.h + 180;
}

function nextVisibleNodeId(nodes: LayoutNode[], selectedId: string, direction: 1 | -1) {
  const sourceIds = nodes
    .slice()
    .sort((left, right) => left.depth - right.depth || left.angle - right.angle)
    .map((node) => node.sourceId);
  const index = Math.max(0, sourceIds.indexOf(selectedId));
  return sourceIds[(index + direction + sourceIds.length) % sourceIds.length] ?? selectedId;
}

function clampZoom(value: number) {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Number(value.toFixed(2))));
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function sampleBezier(x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, x3: number, y3: number, t: number) {
  const mt = 1 - t;
  const a = mt * mt * mt;
  const b = 3 * mt * mt * t;
  const c = 3 * mt * t * t;
  const d = t * t * t;
  return {
    x: a * x0 + b * x1 + c * x2 + d * x3,
    y: a * y0 + b * y1 + c * y2 + d * y3
  };
}

function withAlpha(color: string, alpha: number) {
  const hex = color.replace("#", "");
  const r = Number.parseInt(hex.slice(0, 2), 16);
  const g = Number.parseInt(hex.slice(2, 4), 16);
  const b = Number.parseInt(hex.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
