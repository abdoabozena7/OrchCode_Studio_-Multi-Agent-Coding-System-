import type { AgentPlan, PatchProposal } from "@orchcode/protocol";
import type { LlmProvider, LlmRequest } from "./LlmProvider.js";

export class MockLlmProvider implements LlmProvider {
  async generateStructured<T>(input: LlmRequest, schema: unknown): Promise<T> {
    const schemaName = getSchemaName(schema);
    if (schemaName === "agent-plan") {
      return this.createPlan(input.userPrompt) as T;
    }
    if (schemaName === "patch-proposal") {
      return this.createPatchProposal(input.userPrompt, input.context) as T;
    }
    return {} as T;
  }

  async generateText(input: LlmRequest): Promise<string> {
    return `Mock analysis complete for: ${input.userPrompt}`;
  }

  private createPlan(userPrompt: string): AgentPlan {
    return {
      summary: `Prepare a small, reviewable change for: ${userPrompt}`,
      steps: [
        {
          id: "scan",
          title: "Scan repository",
          detail: "Identify project type, important files, and current git state.",
          status: "completed"
        },
        {
          id: "context",
          title: "Gather context",
          detail: "Search for likely files before reading specific source files.",
          status: "completed"
        },
        {
          id: "patch",
          title: "Prepare patch proposal",
          detail: "Create a non-applied unified diff for user review.",
          status: "completed"
        }
      ],
      acceptanceCriteria: [
        "The proposal is visible before any file is written.",
        "The changed files are explained.",
        "A safe validation command is suggested."
      ],
      risks: [
        "Mock mode generates a representative patch and may not compile against the real code.",
        "Patch application remains disabled until explicit approval plumbing is complete."
      ]
    };
  }

  private createPatchProposal(userPrompt: string, context: unknown): Omit<PatchProposal, "id" | "sessionId" | "createdAt"> {
    if (isThreeJsSnakePrompt(userPrompt)) {
      return createThreeJsSnakeProposal(userPrompt);
    }
    const summaryFile = inferSummaryFile(context);
    const summaryContent = [
      "# Agent Proposal",
      "",
      `Request: ${userPrompt.replaceAll("\n", " ")}`,
      "",
      "This patch was generated in MOCK_LLM mode.",
      "It is intentionally not applied automatically.",
      "Review and approve before any future write operation.",
      "Suggested validation: git diff --check"
    ].join("\n");
    return {
      title: "Mock implementation note",
      summary: `Adds a local implementation note for the requested task: ${userPrompt}`,
      riskLevel: "low",
      filesChanged: [
        {
          path: summaryFile,
          changeType: "create",
          explanation: "Captures the proposed change in a reviewable generated note."
        }
      ],
      artifacts: [
        {
          path: summaryFile,
          content: `${summaryContent}\n`
        }
      ],
      unifiedDiff: [
        `diff --git a/${summaryFile} b/${summaryFile}`,
        "new file mode 100644",
        "index 0000000..1111111",
        "--- /dev/null",
        `+++ b/${summaryFile}`,
        "@@ -0,0 +1,8 @@",
        ...summaryContent.split("\n").map((line) => `+${line}`)
      ].join("\n"),
      requiresApproval: true,
      status: "proposed"
    };
  }
}

function getSchemaName(schema: unknown) {
  if (typeof schema === "object" && schema && "name" in schema) {
    return String((schema as { name: string }).name);
  }
  return "";
}

function inferSummaryFile(context: unknown) {
  if (
    typeof context === "object" &&
    context &&
    "summaryFile" in context &&
    typeof (context as { summaryFile: unknown }).summaryFile === "string"
  ) {
    return (context as { summaryFile: string }).summaryFile;
  }
  return "AGENT_PROPOSAL.md";
}

function isThreeJsSnakePrompt(prompt: string) {
  const normalized = prompt.toLowerCase();
  return normalized.includes("snake") && normalized.includes("threejs") && normalized.includes("html");
}

function createThreeJsSnakeProposal(userPrompt: string): Omit<PatchProposal, "id" | "sessionId" | "createdAt"> {
  const html = `<!DOCTYPE html>
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
`;

  const css = `:root {
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
  backdrop-filter: blur(10px);
}

.hud span {
  color: #b6b6b6;
  font-size: 14px;
}

canvas {
  display: block;
  width: 100vw;
  height: 100vh;
}
`;

  const js = `const canvas = document.getElementById("scene");
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0f0f10);

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
camera.position.set(9, 12, 12);
camera.lookAt(0, 0, 0);

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

const ambient = new THREE.AmbientLight(0xffffff, 1.1);
scene.add(ambient);

const key = new THREE.DirectionalLight(0x49b6e5, 1.5);
key.position.set(8, 12, 6);
scene.add(key);

const boardSize = 12;
const cellSize = 1;
const floor = new THREE.Mesh(
  new THREE.BoxGeometry(boardSize, 0.4, boardSize),
  new THREE.MeshStandardMaterial({ color: 0x18232e, roughness: 0.9 })
);
floor.position.y = -0.3;
scene.add(floor);

const grid = new THREE.GridHelper(boardSize, boardSize, 0x35566b, 0x243949);
scene.add(grid);

const snakeMaterial = new THREE.MeshStandardMaterial({ color: 0x49b6e5, roughness: 0.3 });
const foodMaterial = new THREE.MeshStandardMaterial({ color: 0xd97706, roughness: 0.2 });

let direction = { x: 1, z: 0 };
let pendingDirection = direction;
let snake = [
  { x: 0, z: 0 },
  { x: -1, z: 0 },
  { x: -2, z: 0 }
];
let food = spawnFood();
let lastStep = 0;
const stepDelay = 180;
let score = 0;

const snakeMeshes = [];
const foodMesh = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.8, 0.8), foodMaterial);
scene.add(foodMesh);

function toWorld(value) {
  return value * cellSize;
}

function syncScene() {
  while (snakeMeshes.length < snake.length) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.84, 0.84, 0.84), snakeMaterial);
    scene.add(mesh);
    snakeMeshes.push(mesh);
  }
  snake.forEach((segment, index) => {
    const mesh = snakeMeshes[index];
    mesh.position.set(toWorld(segment.x), 0.4, toWorld(segment.z));
    mesh.scale.setScalar(1 - index * 0.05);
  });
  snakeMeshes.slice(snake.length).forEach((mesh) => mesh.position.set(999, 999, 999));
  foodMesh.position.set(toWorld(food.x), 0.45, toWorld(food.z));
}

function spawnFood() {
  let next = { x: 2, z: 2 };
  do {
    next = {
      x: Math.floor(Math.random() * boardSize - boardSize / 2),
      z: Math.floor(Math.random() * boardSize - boardSize / 2)
    };
  } while (snake.some((segment) => segment.x === next.x && segment.z === next.z));
  return next;
}

function resetGame() {
  direction = { x: 1, z: 0 };
  pendingDirection = direction;
  snake = [{ x: 0, z: 0 }, { x: -1, z: 0 }, { x: -2, z: 0 }];
  food = spawnFood();
  score = 0;
  document.title = "Three.js Snake";
}

function step() {
  direction = pendingDirection;
  const head = snake[0];
  const next = { x: head.x + direction.x, z: head.z + direction.z };
  const limit = boardSize / 2;
  const collision =
    next.x >= limit ||
    next.x < -limit ||
    next.z >= limit ||
    next.z < -limit ||
    snake.some((segment) => segment.x === next.x && segment.z === next.z);
  if (collision) {
    resetGame();
    return;
  }
  snake.unshift(next);
  if (next.x === food.x && next.z === food.z) {
    score += 1;
    document.title = "Three.js Snake - Score " + score;
    food = spawnFood();
  } else {
    snake.pop();
  }
}

window.addEventListener("keydown", (event) => {
  if (event.key === "ArrowUp" && direction.z !== 1) pendingDirection = { x: 0, z: -1 };
  if (event.key === "ArrowDown" && direction.z !== -1) pendingDirection = { x: 0, z: 1 };
  if (event.key === "ArrowLeft" && direction.x !== 1) pendingDirection = { x: -1, z: 0 };
  if (event.key === "ArrowRight" && direction.x !== -1) pendingDirection = { x: 1, z: 0 };
});

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

function animate(time) {
  requestAnimationFrame(animate);
  if (time - lastStep > stepDelay) {
    step();
    lastStep = time;
  }
  syncScene();
  camera.position.x = Math.sin(time * 0.0002) * 2 + 9;
  camera.lookAt(0, 0, 0);
  renderer.render(scene, camera);
}

syncScene();
animate(0);
`;

  return {
    title: "Three.js snake starter",
    summary: `Creates a small HTML, CSS, and JavaScript starter for: ${userPrompt}`,
    riskLevel: "medium",
    filesChanged: [
      { path: "index.html", changeType: "create", explanation: "Main HTML shell and Three.js bootstrapping." },
      { path: "styles.css", changeType: "create", explanation: "Lightweight HUD and canvas styling." },
      { path: "main.js", changeType: "create", explanation: "Basic 3D snake gameplay loop using Three.js." }
    ],
    artifacts: [
      { path: "index.html", content: html },
      { path: "styles.css", content: css },
      { path: "main.js", content: js }
    ],
    unifiedDiff: [
      "diff --git a/index.html b/index.html",
      "new file mode 100644",
      "index 0000000..1111111",
      "--- /dev/null",
      "+++ b/index.html",
      "@@ -0,0 +1,16 @@",
      ...html.trimEnd().split("\n").map((line) => `+${line}`),
      "diff --git a/styles.css b/styles.css",
      "new file mode 100644",
      "index 0000000..1111111",
      "--- /dev/null",
      "+++ b/styles.css",
      "@@ -0,0 +1,24 @@",
      ...css.trimEnd().split("\n").map((line) => `+${line}`),
      "diff --git a/main.js b/main.js",
      "new file mode 100644",
      "index 0000000..1111111",
      "--- /dev/null",
      "+++ b/main.js",
      "@@ -0,0 +1,40 @@",
      ...js.trimEnd().split("\n").map((line) => `+${line}`)
    ].join("\n"),
    requiresApproval: true,
    status: "proposed"
  };
}
