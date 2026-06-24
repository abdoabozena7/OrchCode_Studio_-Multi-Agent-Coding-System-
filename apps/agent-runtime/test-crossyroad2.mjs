import http from "node:http";

const BASE = "http://127.0.0.1:4317";

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      method,
      hostname: "127.0.0.1",
      port: 4317,
      path,
      headers: { "Content-Type": "application/json" },
      timeout: body ? 900_000 : 15_000,
    };
    if (data) opts.headers["Content-Length"] = Buffer.byteLength(data);
    const req = http.request(opts, (res) => {
      let raw = "";
      res.on("data", (chunk) => raw += chunk);
      res.on("end", () => {
        try { resolve(JSON.parse(raw)); } catch { resolve(raw); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    if (data) req.write(data);
    req.end();
  });
}

async function pollSession(sessionId, label, intervalMs = 30_000) {
  const start = Date.now();
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, intervalMs));
    try {
      const s = await request("GET", `/sessions/${sessionId}`);
      const elapsed = ((Date.now() - start) / 1000).toFixed(0);
      console.log(`[${label} +${elapsed}s] status=${s.status} stage=${s.lifecycleStage} intent=${s.intent_contract_status} nextAction=${s.nextAction?.kind || "none"} mode=${s.executionMode}`);
      if (s.status === "completed" || s.status === "failed" || s.status === "blocked") return s;
      if (s.nextAction?.kind === "clarify_request") return { ...s, _clarificationNeeded: true };
    } catch (e) {
      console.log(`[${label}] poll error: ${e.message}`);
    }
  }
  return null;
}

async function main() {
  // 1) Create session
  console.log("=== Creating session ===");
  const created = await request("POST", "/sessions", {
    workspacePath: "D:\\projects\\Ai\\OrchCode_Studio_(Multi-Agent-Coding-System)",
    userPrompt: "Create a 3D Crossy Road game in a single HTML file using Three.js loaded from CDN. Include lane-based roads, obstacles, player character, scoring, and controls.",
    providerConfig: {
      providerType: "ollama",
      providerName: "Ollama",
      baseUrl: "http://127.0.0.1:11434",
      selectedModel: "qwen2.5-coder:7b",
      isValid: true,
      apiKeyConfigured: false,
      id: "ollama-local"
    }
  });
  const sid = created.sessionId;
  console.log("Session:", sid);

  // 2) Send turn (non-blocking: fire and forget, will poll)
  console.log("\n=== Sending turn ===");
  const turnPromise = request("POST", `/sessions/${sid}/turn`, {
    message: "Create a 3D Crossy Road game in a single HTML file using Three.js loaded from CDN. Include lane-based roads, obstacles, player character, scoring, and controls."
  });

  // 3) Poll session state while awaiting turn
  const session = await pollSession(sid, "turn1", 30_000);
  
  // Await turn result (if poll didn't already capture it)
  let turnResult;
  try {
    turnResult = await turnPromise;
    console.log("\nTurn result:", JSON.stringify(turnResult, null, 2));
  } catch (e) {
    console.log("\nTurn promise error:", e.message);
  }

  if (!session) {
    console.log("\nCould not get final session state");
    return;
  }

  // 4) Handle clarification if needed
  if (session._clarificationNeeded) {
    console.log("\n=== Clarification requested — sending dismissive answer ===");
    const turn2promise = request("POST", `/sessions/${sid}/turn`, { message: "just do it" });
    const session2 = await pollSession(sid, "turn2", 30_000);
    try {
      const turn2res = await turn2promise;
      console.log("Turn 2 result:", JSON.stringify(turn2res, null, 2));
    } catch (e) {
      console.log("Turn 2 error:", e.message);
    }
    if (session2) {
      console.log("\n=== Final state after dismissive ===");
      console.log(`status=${session2.status} stage=${session2.lifecycleStage} intent=${session2.intent_contract_status}`);
    }
  }

  // 5) Final snapshot
  console.log("\n=== Final session ===");
  const final = await request("GET", `/sessions/${sid}`);
  console.log(JSON.stringify({
    status: final.status,
    lifecycleStage: final.lifecycleStage,
    intent_contract_status: final.intent_contract_status,
    nextAction: final.nextAction?.kind || null,
    executionMode: final.executionMode,
    messages: final.messages?.length,
    patches: final.patches?.length,
    commands: final.commands?.length,
    summary: final.runSummary?.summary
  }, null, 2));
}

main().catch(console.error);
