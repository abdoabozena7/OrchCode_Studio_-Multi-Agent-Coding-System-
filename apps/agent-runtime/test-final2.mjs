import http from "node:http";
const BASE = "http://127.0.0.1:4317";

function req(method, path, body, timeout = 20_000) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = { method, hostname: "127.0.0.1", port: 4317, path, timeout,
      headers: data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {} };
    const r = http.request(opts, (res) => { let raw = ""; res.on("data", c => raw += c); res.on("end", () => { try { resolve(JSON.parse(raw)); } catch { resolve(raw); } }); });
    r.on("error", reject); r.on("timeout", () => { r.destroy(); reject(new Error("timeout")); });
    if (data) r.write(data); r.end();
  });
}

async function poll(sid, label, interval = 30_000, maxPolls = 60) {
  const start = Date.now();
  for (let i = 0; i < maxPolls; i++) {
    await new Promise(r => setTimeout(r, interval));
    try {
      const s = await req("GET", `/sessions/${sid}`);
      const t = ((Date.now() - start) / 1000).toFixed(0);
      const swarm = s.swarmState?.nodes?.length || 0;
      const orch = s.orchestration?.selectedWorkerAgents?.length || 0;
      const patches = s.patches?.length || 0;
      const commands = s.commands?.length || 0;
      console.log(`[+${t}s] st=${s.status} stage=${s.lifecycleStage} ic=${s.intent_contract_status} mode=${s.resolvedExecutionMode||"-"} swarm=${swarm} orch=${orch} patches=${patches} cmds=${commands} na=${s.nextAction?.kind||"-"}`);
      if (s.status !== "running") return s;
    } catch (e) { console.log(`  poll err: ${e.message}`); }
  }
  return null;
}

async function main() {
  console.log("=== Creating session (orchestrated_mode) ===");
  let c = await req("POST", "/sessions", {
    workspacePath: "D:\\projects\\Ai\\OrchCode_Studio_(Multi-Agent-Coding-System)",
    userPrompt: "Create a 3D Crossy Road game in a single HTML file using Three.js from CDN",
    executionMode: "orchestrated_mode",
    providerConfig: { providerType: "ollama", providerName: "Ollama", baseUrl: "http://127.0.0.1:11434", selectedModel: "qwen2.5-coder:7b", isValid: true, apiKeyConfigured: false, id: "ollama-local" }
  });
  const sid = c.sessionId;
  console.log("Session:", sid);

  console.log("\n=== Sending turn ===");
  const turnP = req("POST", `/sessions/${sid}/turn`, {
    message: "Create a 3D Crossy Road game in a single HTML file using Three.js from CDN"
  }, 2_400_000); // 40min

  const final = await poll(sid, "crossy", 30_000, 60);
  try { const r = await turnP; console.log("Turn:", JSON.stringify(r)); }
  catch (e) { console.log("Turn error:", e.message); }

  console.log("\n=== Final ===");
  const snap = await req("GET", `/sessions/${sid}`);
  console.log(JSON.stringify({
    status: snap.status, stage: snap.lifecycleStage, mode: snap.resolvedExecutionMode,
    ic: snap.intent_contract_status, swarm: snap.swarmState?.nodes?.length,
    agents: snap.orchestration?.selectedWorkerAgents,
    patches: snap.patches?.length, commands: snap.commands?.length,
    summary: snap.runSummary?.summary?.slice(0, 300)
  }, null, 2));
}

main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
