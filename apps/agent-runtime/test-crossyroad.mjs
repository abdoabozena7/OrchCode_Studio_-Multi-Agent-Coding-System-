import http from "node:http";

const BASE = "http://127.0.0.1:4317";

function post(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(`${BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
      timeout: 600_000,
    }, (res) => {
      let raw = "";
      res.on("data", (chunk) => raw += chunk);
      res.on("end", () => {
        try { resolve(JSON.parse(raw)); } catch { resolve(raw); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.write(data);
    req.end();
  });
}

function get(path) {
  return new Promise((resolve, reject) => {
    const req = http.get(`${BASE}${path}`, { timeout: 10_000 }, (res) => {
      let raw = "";
      res.on("data", (chunk) => raw += chunk);
      res.on("end", () => {
        try { resolve(JSON.parse(raw)); } catch { resolve(raw); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
  });
}

async function main() {
  // Create session
  console.log("=== Creating session ===");
  const created = await post("/sessions", {
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
  console.log("Created:", JSON.stringify(created));
  const sessionId = created.sessionId;

  // Send turn
  console.log("\n=== Sending turn ===");
  const turnResult = await post(`/sessions/${sessionId}/turn`, {
    message: "Create a 3D Crossy Road game in a single HTML file using Three.js loaded from CDN. Include lane-based roads, obstacles, player character, scoring, and controls."
  });
  console.log("Turn result:", JSON.stringify(turnResult, null, 2));

  // Check session state
  console.log("\n=== Session state ===");
  const session = await get(`/sessions/${sessionId}`);
  console.log("Status:", session.status);
  console.log("LifecycleStage:", session.lifecycleStage);
  console.log("Intent contract status:", session.intent_contract_status);
  console.log("nextAction:", JSON.stringify(session.nextAction));

  if (session.nextAction?.kind === "clarify_request") {
    console.log("\n=== Clarification requested — sending dismissive answer ===");
    const turn2 = await post(`/sessions/${sessionId}/turn`, { message: "just do it" });
    console.log("Turn 2 result:", JSON.stringify(turn2, null, 2));

    const session2 = await get(`/sessions/${sessionId}`);
    console.log("\n=== Session state after dismissive ===");
    console.log("Status:", session2.status);
    console.log("LifecycleStage:", session2.lifecycleStage);
    console.log("Intent contract status:", session2.intent_contract_status);
  }
}

main().catch(console.error);
