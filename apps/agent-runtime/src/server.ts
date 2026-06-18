import Fastify from "fastify";
import type { FastifyInstance, FastifyReply } from "fastify";
import type {
  CreateRuntimeSessionRequest,
  FactoryApprovalDecisionRequest,
  RecursiveBranchExecutionStartRequest,
  ReportCommandResultRequest,
  ReportPatchApplyResultRequest,
  RuntimeTurnRequest
} from "@hivo/protocol";
import { loadConfig, type RuntimeConfig } from "./config.js";
import { AgentRuntime, ProviderConfigurationError } from "./runtime/AgentRuntime.js";
import { EventBus } from "./runtime/EventBus.js";
import { SessionManager, type SessionTokenValidation } from "./runtime/SessionManager.js";

export type RuntimeServer = {
  app: FastifyInstance;
  runtime: AgentRuntime;
  sessionManager: SessionManager;
};

export async function buildServer(config: RuntimeConfig = loadConfig()): Promise<RuntimeServer> {
  const app = Fastify({ logger: false });
  const startedAt = new Date().toISOString();
  const eventBus = new EventBus();
  const sessionManager = new SessionManager(config.storageDir, eventBus);
  await sessionManager.load();
  const runtime = new AgentRuntime(config, sessionManager);

  app.addHook("onRequest", async (_request, reply) => {
    reply.header("Access-Control-Allow-Origin", "*");
    reply.header("Access-Control-Allow-Headers", "content-type,x-hivo-session-token,x-orchcode-session-token");
    reply.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  });

  app.options("*", async (_request, reply) => reply.status(204).send());

  app.get("/health", async () => ({ status: "ok", mode: config.defaultMode, startedAt }));

  app.post("/sessions", async (request, reply) => {
    const body = request.body as CreateRuntimeSessionRequest;
    if (!body?.workspacePath || !body.userPrompt) {
      return reply.status(400).send({ error: "workspacePath and userPrompt are required" });
    }
    try {
      return await runtime.createSession(body);
    } catch (error) {
      if (error instanceof ProviderConfigurationError) {
        return reply.status(400).send({ error: error.message, code: error.code });
      }
      throw error;
    }
  });

  app.post("/sessions/:id/turn", async (request, reply) => {
    const { id } = request.params as { id: string };
    const auth = authorizeSessionRequest(sessionManager, id, request);
    if (!auth.ok) return sendSessionAuthFailure(reply, auth);
    const body = request.body as RuntimeTurnRequest;
    if (!body?.message) {
      return reply.status(400).send({ error: "message is required" });
    }
    return runtime.runTurn(id, body.message);
  });

  app.get("/sessions/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const auth = authorizeSessionRequest(sessionManager, id, request);
    if (!auth.ok) return sendSessionAuthFailure(reply, auth);
    const session = runtime.getSession(id);
    if (!session) return reply.status(404).send({ error: "Session not found" });
    return session;
  });

  app.post("/sessions/:id/factory/product-spec/decision", async (request, reply) => {
    const { id } = request.params as { id: string };
    const auth = authorizeSessionRequest(sessionManager, id, request);
    if (!auth.ok) return sendSessionAuthFailure(reply, auth);
    const body = request.body as FactoryApprovalDecisionRequest;
    if (!isFactoryDecision(body?.decision)) return reply.status(400).send({ error: "valid decision is required" });
    try {
      return await runtime.decideProductSpec(id, body);
    } catch (error) {
      return reply.status(409).send({ error: String(error) });
    }
  });

  app.post("/sessions/:id/factory/technical-plan/decision", async (request, reply) => {
    const { id } = request.params as { id: string };
    const auth = authorizeSessionRequest(sessionManager, id, request);
    if (!auth.ok) return sendSessionAuthFailure(reply, auth);
    const body = request.body as FactoryApprovalDecisionRequest;
    if (!isFactoryDecision(body?.decision)) return reply.status(400).send({ error: "valid decision is required" });
    try {
      return await runtime.decideTechnicalPlan(id, body);
    } catch (error) {
      return reply.status(409).send({ error: String(error) });
    }
  });

  app.post("/sessions/:id/factory/branch-execution/start", async (request, reply) => {
    const { id } = request.params as { id: string };
    const auth = authorizeSessionRequest(sessionManager, id, request);
    if (!auth.ok) return sendSessionAuthFailure(reply, auth);
    const body = request.body as RecursiveBranchExecutionStartRequest;
    if (body?.approved !== true) return reply.status(400).send({ error: "approved=true is required" });
    try {
      return await runtime.startRecursiveBranchExecution(id, body);
    } catch (error) {
      return reply.status(409).send({ error: String(error) });
    }
  });

  app.get("/sessions/:id/events", async (request, reply) => {
    const { id } = request.params as { id: string };
    const auth = authorizeSessionRequest(sessionManager, id, request);
    if (!auth.ok) return sendSessionAuthFailure(reply, auth);
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "access-control-allow-origin": "*"
    });
    const unsubscribe = eventBus.subscribe((event) => {
      if ("sessionId" in event && event.sessionId !== id) return;
      if (event.type === "runtime.session.updated" && event.session.id !== id) return;
      reply.raw.write(`event: ${event.type}\n`);
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    });
    request.raw.on("close", unsubscribe);
  });

  app.post("/sessions/:id/patches/:patchId/approve", async (request, reply) => {
    const { id, patchId } = request.params as { id: string; patchId: string };
    const auth = authorizeSessionRequest(sessionManager, id, request);
    if (!auth.ok) return sendSessionAuthFailure(reply, auth);
    try {
      return await runtime.approvePatch(id, patchId);
    } catch (error) {
      return reply.status(404).send({ error: String(error) });
    }
  });

  app.post("/sessions/:id/patches/:patchId/reject", async (request, reply) => {
    const { id, patchId } = request.params as { id: string; patchId: string };
    const auth = authorizeSessionRequest(sessionManager, id, request);
    if (!auth.ok) return sendSessionAuthFailure(reply, auth);
    try {
      return await runtime.rejectPatch(id, patchId);
    } catch (error) {
      return reply.status(404).send({ error: String(error) });
    }
  });

  app.post("/sessions/:id/patches/:patchId/result", async (request, reply) => {
    const { id, patchId } = request.params as { id: string; patchId: string };
    const auth = authorizeSessionRequest(sessionManager, id, request);
    if (!auth.ok) return sendSessionAuthFailure(reply, auth);
    const body = request.body as ReportPatchApplyResultRequest;
    if (!body?.status || !body?.message) {
      return reply.status(400).send({ error: "status and message are required" });
    }
    try {
      return await runtime.reportPatchApplyResult(id, patchId, body);
    } catch (error) {
      return reply.status(404).send({ error: String(error) });
    }
  });

  app.post("/sessions/:id/commands/:requestId/result", async (request, reply) => {
    const { id, requestId } = request.params as { id: string; requestId: string };
    const auth = authorizeSessionRequest(sessionManager, id, request);
    if (!auth.ok) return sendSessionAuthFailure(reply, auth);
    const body = request.body as ReportCommandResultRequest;
    if (!body?.command || !body?.cwd || !body?.risk || !body?.status) {
      return reply.status(400).send({ error: "command, cwd, risk, and status are required" });
    }
    try {
      return await runtime.reportCommandResult(id, requestId, body);
    } catch (error) {
      return reply.status(404).send({ error: String(error) });
    }
  });

  return { app, runtime, sessionManager };
}

function isFactoryDecision(value: unknown): value is FactoryApprovalDecisionRequest["decision"] {
  return value === "approved" || value === "rejected" || value === "changes_requested";
}

function authorizeSessionRequest(sessionManager: SessionManager, sessionId: string, request: { headers: Record<string, unknown>; query?: unknown }) {
  const header = request.headers["x-hivo-session-token"] ?? request.headers["x-orchcode-session-token"];
  const queryToken =
    typeof request.query === "object" && request.query && "token" in request.query
      ? String((request.query as { token?: unknown }).token ?? "")
      : undefined;
  const token = typeof header === "string" ? header : Array.isArray(header) ? header[0] : queryToken;
  return sessionManager.checkSessionToken(sessionId, token);
}

function sendSessionAuthFailure(reply: FastifyReply, auth: Extract<SessionTokenValidation, { ok: false }>) {
  return reply.status(401).send({ error: auth.message, code: auth.code });
}
