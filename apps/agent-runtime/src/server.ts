import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import type {
  CreateRuntimeSessionRequest,
  ReportCommandResultRequest,
  ReportPatchApplyResultRequest,
  RuntimeTurnRequest
} from "@orchcode/protocol";
import { loadConfig, type RuntimeConfig } from "./config.js";
import { AgentRuntime } from "./runtime/AgentRuntime.js";
import { EventBus } from "./runtime/EventBus.js";
import { SessionManager } from "./runtime/SessionManager.js";

export type RuntimeServer = {
  app: FastifyInstance;
  runtime: AgentRuntime;
  sessionManager: SessionManager;
};

export async function buildServer(config: RuntimeConfig = loadConfig()): Promise<RuntimeServer> {
  const app = Fastify({ logger: false });
  const eventBus = new EventBus();
  const sessionManager = new SessionManager(config.storageDir, eventBus);
  await sessionManager.load();
  const runtime = new AgentRuntime(config, sessionManager);

  app.addHook("onRequest", async (_request, reply) => {
    reply.header("Access-Control-Allow-Origin", "*");
    reply.header("Access-Control-Allow-Headers", "content-type,x-orchcode-session-token");
    reply.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  });

  app.options("*", async (_request, reply) => reply.status(204).send());

  app.get("/health", async () => ({ status: "ok", mode: config.defaultMode }));

  app.post("/sessions", async (request, reply) => {
    const body = request.body as CreateRuntimeSessionRequest;
    if (!body?.workspacePath || !body.userPrompt) {
      return reply.status(400).send({ error: "workspacePath and userPrompt are required" });
    }
    return runtime.createSession(body);
  });

  app.post("/sessions/:id/turn", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!authorizeSessionRequest(sessionManager, id, request)) {
      return reply.status(401).send({ error: "Missing, invalid, or expired session token" });
    }
    const body = request.body as RuntimeTurnRequest;
    if (!body?.message) {
      return reply.status(400).send({ error: "message is required" });
    }
    return runtime.runTurn(id, body.message);
  });

  app.get("/sessions/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!authorizeSessionRequest(sessionManager, id, request)) {
      return reply.status(401).send({ error: "Missing, invalid, or expired session token" });
    }
    const session = runtime.getSession(id);
    if (!session) return reply.status(404).send({ error: "Session not found" });
    return session;
  });

  app.get("/sessions/:id/events", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!authorizeSessionRequest(sessionManager, id, request)) {
      return reply.status(401).send({ error: "Missing, invalid, or expired session token" });
    }
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
    if (!authorizeSessionRequest(sessionManager, id, request)) {
      return reply.status(401).send({ error: "Missing, invalid, or expired session token" });
    }
    try {
      return await runtime.approvePatch(id, patchId);
    } catch (error) {
      return reply.status(404).send({ error: String(error) });
    }
  });

  app.post("/sessions/:id/patches/:patchId/reject", async (request, reply) => {
    const { id, patchId } = request.params as { id: string; patchId: string };
    if (!authorizeSessionRequest(sessionManager, id, request)) {
      return reply.status(401).send({ error: "Missing, invalid, or expired session token" });
    }
    try {
      return await runtime.rejectPatch(id, patchId);
    } catch (error) {
      return reply.status(404).send({ error: String(error) });
    }
  });

  app.post("/sessions/:id/patches/:patchId/result", async (request, reply) => {
    const { id, patchId } = request.params as { id: string; patchId: string };
    if (!authorizeSessionRequest(sessionManager, id, request)) {
      return reply.status(401).send({ error: "Missing, invalid, or expired session token" });
    }
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
    if (!authorizeSessionRequest(sessionManager, id, request)) {
      return reply.status(401).send({ error: "Missing, invalid, or expired session token" });
    }
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

function authorizeSessionRequest(sessionManager: SessionManager, sessionId: string, request: { headers: Record<string, unknown>; query?: unknown }) {
  const header = request.headers["x-orchcode-session-token"];
  const queryToken =
    typeof request.query === "object" && request.query && "token" in request.query
      ? String((request.query as { token?: unknown }).token ?? "")
      : undefined;
  const token = typeof header === "string" ? header : Array.isArray(header) ? header[0] : queryToken;
  return sessionManager.validateSessionToken(sessionId, token);
}
