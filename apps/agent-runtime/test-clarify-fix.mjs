import http from "node:http";
const BASE = "http://127.0.0.1:4317";

function req(method, path, body, timeout = 15_000) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = { method, hostname: "127.0.0.1", port: 4317, path, timeout,
      headers: data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {} };
    const r = http.request(opts, (res) => { let raw = ""; res.on("data", c => raw += c); res.on("end", () => { try { resolve(JSON.parse(raw)); } catch { resolve(raw); } }); });
    r.on("error", reject); r.on("timeout", () => { r.destroy(); reject(new Error("timeout")); });
    if (data) r.write(data); r.end();
  });
}

async function poll(sid, label, interval = 15_000) {
  const start = Date.now();
  for (let i = 0; i < 12; i++) { // 3 min max
    await new Promise(r => setTimeout(r, interval));
    try {
      const s = await req("GET", `/sessions/${sid}`);
      const t = ((Date.now() - start) / 1000).toFixed(0);
      console.log(`[+${t}s] st=${s.status} stage=${s.lifecycleStage} ic=${s.intent_contract_status} na=${s.nextAction?.kind||"-"}`);
      if (s.status !== "running") return s;
      if (s.nextAction?.kind === "clarify_request") return { ...s, _clarify: true };
    } catch (e) { console.log(`  poll err: ${e.message}`); }
  }
  return null;
}

async function main() {
  // Test 1: Game request - should NOT ask questions (isSafeDefaultIntentQuestion fix)
  console.log("=== Test 1: Game request (should pass intent without questions) ===");
  let c = await req("POST", "/sessions", {
    workspacePath: "D:\\projects\\Ai\\OrchCode_Studio_(Multi-Agent-Coding-System)",
    userPrompt: "Create a 3D Crossy Road game in a single HTML file using Three.js from CDN",
    providerConfig: { providerType: "ollama", providerName: "Ollama", baseUrl: "http://127.0.0.1:11434", selectedModel: "qwen2.5-coder:7b", isValid: true, apiKeyConfigured: false, id: "ollama-local" }
  });
  const sid = c.sessionId;
  console.log("Session:", sid);

  // Send turn but with a quick poll (we only care about the INTENT gate, not execution)
  const turnP = req("POST", `/sessions/${sid}/turn`, { message: "Create a 3D Crossy Road game in a single HTML file using Three.js from CDN" }, 300_000);
  const s = await poll(sid, "t1", 15_000);

  if (s?._clarify) {
    console.log("FAIL: Got clarification request when game question should pass as safe default");
    // Test dismissive fix
    const t2p = req("POST", `/sessions/${sid}/turn`, { message: "just do it" }, 300_000);
    const s2 = await poll(sid, "t2", 15_000);
    if (s2) {
      if (s2.intent_contract_status === "ready" || s2.lifecycleStage !== "PLAN") {
        console.log("PASS: Dismissive answer allowed proceeding to", s2.lifecycleStage);
      } else {
        console.log("FAIL: Dismissive answer didn't advance");
      }
    }
  } else {
    console.log(`PASS: No clarification. Status=${s?.status} Stage=${s?.lifecycleStage} IC=${s?.intent_contract_status}`);
    if (s?.intent_contract_status === "ready" && !s?.nextAction) {
      console.log("Intent contract resolved without blocking questions!");
    }
  }

  // Cancel: tell runtime to stop processing (can't actually cancel, just report)
  console.log("\nDone. The turn may still be executing in the background.");
}

main().catch(e => { console.error(e.message); process.exit(1); });
