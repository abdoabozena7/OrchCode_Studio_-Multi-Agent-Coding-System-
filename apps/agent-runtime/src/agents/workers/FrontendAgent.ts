import type { TaskNode } from "@orchcode/protocol";
import { BaseWorker, type WorkerContext } from "./BaseWorker.js";

export class FrontendAgent extends BaseWorker {
  readonly agentName = "FrontendAgent";

  protected execute(task: TaskNode, context: WorkerContext) {
    if (isThreeJsSnakePrompt(context.userPrompt)) {
      const files = createThreeJsSnakeFiles();
      const patch = context.tools.patch.propose(
        {
          title: "Three.js snake implementation",
          summary: "Creates a small HTML/CSS/JS project for a 3D snake demo.",
          riskLevel: task.riskLevel,
          filesChanged: [
            { path: "index.html", changeType: "create", explanation: "Bootstraps the Three.js scene and HUD." },
            { path: "styles.css", changeType: "create", explanation: "Styles the canvas and HUD." },
            { path: "main.js", changeType: "create", explanation: "Implements the 3D snake loop and controls." }
          ],
          artifacts: Object.entries(files).map(([path, content]) => ({ path, content })),
          unifiedDiff: buildCreateDiff(files),
          requiresApproval: true,
          status: "proposed"
        },
        context.sessionId
      );
      return {
        summary: "Prepared a real static frontend patch proposal for a Three.js snake game.",
        details: ["Creates index.html, styles.css, and main.js.", "Uses CDN Three.js so the result can open without package install."],
        risks: ["Game logic is intentionally lightweight in mock mode."],
        patch
      };
    }

    const target = task.fileLocks[0] ?? "apps/desktop/src/app/App.tsx";
    const nextContent = context.tools.workspace.fileExists(target)
      ? `// MOCK_ORCHESTRATED_FRONTEND_CHANGE: review before applying\n${context.tools.workspace.readWholeFile(target)}`
      : "// MOCK_ORCHESTRATED_FRONTEND_CHANGE: review before applying\n";
    const patch = context.tools.patch.propose(
      {
        title: "Frontend implementation proposal",
        summary: `Mock frontend patch for: ${context.userPrompt}`,
        riskLevel: task.riskLevel,
        filesChanged: [{ path: target, changeType: "modify", explanation: "Representative UI change proposed by FrontendAgent." }],
        artifacts: [{ path: target, content: nextContent }],
        unifiedDiff: [
          `diff --git a/${target} b/${target}`,
          `--- a/${target}`,
          `+++ b/${target}`,
          "@@ -1,3 +1,4 @@",
          "+// MOCK_ORCHESTRATED_FRONTEND_CHANGE: review before applying",
          " import React from \"react\";"
        ].join("\n"),
        requiresApproval: true,
        status: "proposed"
      },
      context.sessionId
    );
    return {
      summary: "Prepared a frontend patch proposal.",
      details: [`Target file: ${target}`, "Patch is not applied and requires user approval."],
      risks: ["Generated diff is representative in mock mode."],
      patch
    };
  }
}

function isThreeJsSnakePrompt(prompt: string) {
  const normalized = prompt.toLowerCase();
  return normalized.includes("snake") && normalized.includes("threejs") && normalized.includes("html");
}

function createThreeJsSnakeFiles() {
  return {
    "index.html": `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Three.js Snake</title>
    <link rel="stylesheet" href="./styles.css" />
  </head>
  <body>
    <div class="hud">
      <strong>Three.js Snake</strong>
      <span>Arrow keys to steer</span>
    </div>
    <canvas id="scene"></canvas>
    <script src="https://unpkg.com/three@0.165.0/build/three.min.js"></script>
    <script src="./main.js"></script>
  </body>
</html>
`,
    "styles.css": `:root {
  color-scheme: dark;
  font-family: "Segoe UI", system-ui, sans-serif;
  background: #101010;
  color: #f5f5f5;
}

body {
  margin: 0;
  overflow: hidden;
  background:
    radial-gradient(circle at top, rgba(73, 182, 229, 0.14), transparent 28%),
    #101010;
}

.hud {
  position: fixed;
  top: 16px;
  left: 16px;
  z-index: 10;
  display: grid;
  gap: 4px;
  padding: 12px 14px;
  border-radius: 14px;
  background: rgba(15, 15, 15, 0.78);
}

canvas {
  display: block;
  width: 100vw;
  height: 100vh;
}
`,
    "main.js": `const canvas = document.getElementById("scene");
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0f0f10);

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
camera.position.set(9, 12, 12);
camera.lookAt(0, 0, 0);

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);

scene.add(new THREE.AmbientLight(0xffffff, 1.1));
const key = new THREE.DirectionalLight(0x49b6e5, 1.5);
key.position.set(8, 12, 6);
scene.add(key);

const floor = new THREE.Mesh(
  new THREE.BoxGeometry(12, 0.4, 12),
  new THREE.MeshStandardMaterial({ color: 0x18232e, roughness: 0.9 })
);
floor.position.y = -0.3;
scene.add(floor);
scene.add(new THREE.GridHelper(12, 12, 0x35566b, 0x243949));

let angle = 0;
function animate() {
  requestAnimationFrame(animate);
  angle += 0.01;
  camera.position.x = Math.sin(angle) * 3 + 9;
  camera.lookAt(0, 0, 0);
  renderer.render(scene, camera);
}

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

animate();
`
  };
}

function buildCreateDiff(files: Record<string, string>) {
  return Object.entries(files)
    .flatMap(([target, content]) => [
      `diff --git a/${target} b/${target}`,
      "new file mode 100644",
      "index 0000000..1111111",
      "--- /dev/null",
      `+++ b/${target}`,
      "@@ -0,0 +1,1 @@",
      ...content.trimEnd().split("\n").map((line) => `+${line}`)
    ])
    .join("\n");
}
