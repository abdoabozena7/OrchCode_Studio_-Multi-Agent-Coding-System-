import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import type { CreateRuntimeSessionRequest, RuntimeTurnRequest } from "@orchcode/protocol";
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
    reply.header("Access-Control-Allow-Headers", "content-type");
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
    const body = request.body as RuntimeTurnRequest;
    if (!body?.message) {
      return reply.status(400).send({ error: "message is required" });
    }
    return runtime.runTurn(id, body.message);
  });

  app.get("/sessions/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = runtime.getSession(id);
    if (!session) return reply.status(404).send({ error: "Session not found" });
    return session;
  });

  app.get("/sessions/:id/events", async (request, reply) => {
    const { id } = request.params as { id: string };
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
    try {
      return await runtime.approvePatch(id, patchId);
    } catch (error) {
      return reply.status(404).send({ error: String(error) });
    }
  });

  app.post("/sessions/:id/patches/:patchId/reject", async (request, reply) => {
    const { id, patchId } = request.params as { id: string; patchId: string };
    try {
      return await runtime.rejectPatch(id, patchId);
    } catch (error) {
      return reply.status(404).send({ error: String(error) });
    }
  });

  return { app, runtime, sessionManager };
}
