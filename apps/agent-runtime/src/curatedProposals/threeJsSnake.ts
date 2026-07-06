import type { PatchProposal } from "@hivo/protocol";

type SnakeProposalOptions = {
  title?: string;
  summary?: string;
  riskLevel?: PatchProposal["riskLevel"];
};

type SnakeValidationResult = {
  valid: boolean;
  blockingReasons: string[];
  reviewerNotes: string[];
};

export function isThreeJsSnakePrompt(prompt: string) {
  const normalized = prompt.toLowerCase();
  return normalized.includes("snake") && normalized.includes("threejs") && normalized.includes("html");
}

export function validateThreeJsSnakeProposal(
  proposal: Pick<PatchProposal, "artifacts" | "filesChanged" | "unifiedDiff" | "title">
): SnakeValidationResult {
  const artifacts = new Map(proposal.artifacts?.map((artifact) => [artifact.path, artifact.content]) ?? []);
  const html = artifacts.get("index.html") ?? "";
  const css = artifacts.get("styles.css") ?? "";
  const js = artifacts.get("main.js") ?? "";
  const all = `${html}\n${css}\n${js}`;
  const blockingReasons: string[] = [];
  const reviewerNotes: string[] = [];

  const requiredFiles = ["index.html", "styles.css", "main.js"];
  for (const file of requiredFiles) {
    if (!proposal.filesChanged.some((change) => change.path === file) || !artifacts.has(file)) {
      blockingReasons.push(`${proposal.title} is missing ${file}.`);
    }
  }

  if (/build\/three\.min\.js/.test(all)) {
    blockingReasons.push("Uses the removed Three.js UMD bundle path build/three.min.js; use the module build instead.");
  }
  if (!/type="module"/.test(html)) {
    blockingReasons.push("index.html must load main.js as an ES module.");
  }
  if (!/three\.module\.js/.test(js)) {
    blockingReasons.push("main.js must import Three.js from a module build that is reachable in browsers.");
  }
  if (!/<canvas[^>]+id="scene"/.test(html)) {
    blockingReasons.push("index.html must expose a render canvas with id scene.");
  }

  const requiredGameplayChecks: Array<[RegExp, string]> = [
    [/class SnakeGame/, "stateful SnakeGame controller"],
    [/new THREE\.WebGLRenderer/, "Three.js WebGL renderer"],
    [/renderSnake/, "snake mesh rendering"],
    [/renderFood/, "food mesh rendering"],
    [/spawnFood/, "food spawning"],
    [/isWallCollision/, "wall collision detection"],
    [/isSelfCollision/, "self collision detection"],
    [/restartGame/, "restart behavior"],
    [/setDirection/, "direction changes"],
    [/keydown/, "keyboard controls"],
    [/scoreLabel/, "score display updates"],
    [/requestAnimationFrame/, "animation loop"]
  ];
  for (const [pattern, label] of requiredGameplayChecks) {
    if (!pattern.test(js)) {
      blockingReasons.push(`main.js is missing ${label}.`);
    }
  }

  const requiredUiChecks: Array<[RegExp, string]> = [
    [/\.game-shell/, "centered game shell"],
    [/\.status-card/, "score/status cards"],
    [/\.overlay/, "start/game-over overlay"],
    [/\.controls/, "visible controls help"]
  ];
  for (const [pattern, label] of requiredUiChecks) {
    if (!pattern.test(css)) {
      blockingReasons.push(`styles.css is missing ${label}.`);
    }
  }

  if (!blockingReasons.length) {
    reviewerNotes.push("Playable Three.js snake artifact includes module loading, rendering, movement, food, scoring, collision, restart, and UI states.");
  }

  return {
    valid: blockingReasons.length === 0,
    blockingReasons,
    reviewerNotes
  };
}

export function createThreeJsSnakeProposal(
  userPrompt: string,
  options: SnakeProposalOptions = {}
): Omit<PatchProposal, "id" | "sessionId" | "createdAt"> {
  const html = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Three.js Snake Arena</title>
    <link rel="stylesheet" href="./styles.css" />
  </head>
  <body>
    <main class="game-shell">
      <section class="hud" aria-label="Game status">
        <div>
          <p class="eyebrow">Three.js arcade</p>
          <h1>Snake Arena</h1>
        </div>
        <div class="status-grid">
          <div class="status-card">
            <span>Score</span>
            <strong id="score">0</strong>
          </div>
          <div class="status-card">
            <span>Best</span>
            <strong id="best">0</strong>
          </div>
          <div class="status-card">
            <span>Speed</span>
            <strong id="speed">1x</strong>
          </div>
        </div>
      </section>

      <canvas id="scene" aria-label="3D snake game board"></canvas>

      <section class="overlay" id="overlay" aria-live="polite">
        <h2 id="overlay-title">Ready?</h2>
        <p id="overlay-copy">Use arrow keys or WASD to steer. Eat the amber cubes and avoid the walls.</p>
        <button id="restart" type="button">Start game</button>
      </section>

      <section class="controls" aria-label="Controls">
        <span>Arrow keys / WASD</span>
        <span>Space to pause</span>
        <span>R to restart</span>
      </section>
    </main>

    <script type="module" src="./main.js"></script>
  </body>
</html>
`;

  const css = `:root {
  color-scheme: dark;
  font-family: Inter, "Segoe UI", system-ui, sans-serif;
  background: #080b10;
  color: #f7fbff;
}

* {
  box-sizing: border-box;
}

html,
body {
  width: 100%;
  height: 100%;
}

body {
  margin: 0;
  overflow: hidden;
  background:
    radial-gradient(circle at 20% 12%, rgba(73, 182, 229, 0.24), transparent 28%),
    radial-gradient(circle at 82% 16%, rgba(217, 119, 6, 0.14), transparent 26%),
    linear-gradient(140deg, #090d14 0%, #101621 48%, #07090d 100%);
}

button {
  border: 0;
  border-radius: 999px;
  padding: 12px 18px;
  background: #49b6e5;
  color: #061018;
  font: inherit;
  font-weight: 800;
  cursor: pointer;
}

button:focus-visible {
  outline: 3px solid #ffffff;
  outline-offset: 3px;
}

.game-shell {
  position: relative;
  width: 100vw;
  height: 100vh;
  min-height: 560px;
}

#scene {
  display: block;
  width: 100%;
  height: 100%;
}

.hud {
  position: fixed;
  top: 24px;
  left: 24px;
  right: 24px;
  z-index: 4;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 18px;
  pointer-events: none;
}

.eyebrow,
.status-card span,
.controls {
  color: rgba(247, 251, 255, 0.68);
}

.eyebrow {
  margin: 0 0 4px;
  font-size: 13px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
}

h1,
h2,
p {
  margin: 0;
}

h1 {
  font-size: clamp(32px, 4vw, 58px);
  line-height: 0.95;
}

.status-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(82px, 1fr));
  gap: 10px;
}

.status-card,
.overlay,
.controls {
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: rgba(8, 11, 16, 0.68);
  box-shadow: 0 18px 60px rgba(0, 0, 0, 0.32);
  backdrop-filter: blur(18px);
}

.status-card {
  display: grid;
  gap: 3px;
  min-width: 92px;
  border-radius: 18px;
  padding: 12px 14px;
}

.status-card strong {
  font-size: 24px;
}

.overlay {
  position: fixed;
  z-index: 5;
  left: 50%;
  top: 50%;
  display: grid;
  gap: 14px;
  width: min(420px, calc(100vw - 36px));
  transform: translate(-50%, -50%);
  border-radius: 24px;
  padding: 24px;
  text-align: center;
}

.overlay.hidden {
  display: none;
}

.overlay h2 {
  font-size: 30px;
}

.overlay p {
  color: rgba(247, 251, 255, 0.76);
  line-height: 1.55;
}

.controls {
  position: fixed;
  left: 50%;
  bottom: 22px;
  z-index: 4;
  display: flex;
  gap: 14px;
  transform: translateX(-50%);
  border-radius: 999px;
  padding: 10px 14px;
  font-size: 14px;
}

@media (max-width: 720px) {
  .hud {
    display: grid;
  }

  .status-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .controls {
    width: calc(100vw - 32px);
    justify-content: center;
    flex-wrap: wrap;
    border-radius: 18px;
  }
}
`;

  const js = `import * as THREE from "https://unpkg.com/three@0.165.0/build/three.module.js";

const canvas = document.getElementById("scene");
const scoreLabel = document.getElementById("score");
const bestLabel = document.getElementById("best");
const speedLabel = document.getElementById("speed");
const overlay = document.getElementById("overlay");
const overlayTitle = document.getElementById("overlay-title");
const overlayCopy = document.getElementById("overlay-copy");
const restartButton = document.getElementById("restart");

class SnakeGame {
  constructor() {
    this.boardSize = 17;
    this.cellSize = 1;
    this.half = Math.floor(this.boardSize / 2);
    this.baseStepMs = 170;
    this.lastStepAt = 0;
    this.score = 0;
    this.best = Number(localStorage.getItem("snakeArenaBest") || "0");
    this.started = false;
    this.paused = false;
    this.gameOver = false;
    this.direction = { x: 1, z: 0 };
    this.nextDirection = { x: 1, z: 0 };
    this.snake = [];
    this.snakeMeshes = [];

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x080b10);
    this.camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 1000);
    this.camera.position.set(10, 13, 15);
    this.camera.lookAt(0, 0, 0);

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;

    this.snakeMaterial = new THREE.MeshStandardMaterial({ color: 0x49b6e5, roughness: 0.35, metalness: 0.08 });
    this.headMaterial = new THREE.MeshStandardMaterial({ color: 0x8be2ff, roughness: 0.28, metalness: 0.14 });
    this.foodMaterial = new THREE.MeshStandardMaterial({ color: 0xf59e0b, roughness: 0.25, emissive: 0x5a2600 });
    this.wallMaterial = new THREE.MeshStandardMaterial({ color: 0x263d5b, roughness: 0.65 });

    this.setupWorld();
    this.restartGame();
    this.bindInput();
    this.updateHud();
    this.showOverlay("Ready?", "Use arrow keys or WASD to steer. Eat the amber cubes and avoid the walls.", "Start game");
    requestAnimationFrame((time) => this.animate(time));
  }

  setupWorld() {
    this.scene.add(new THREE.HemisphereLight(0xdff7ff, 0x172131, 1.3));
    const key = new THREE.DirectionalLight(0xffffff, 2);
    key.position.set(6, 12, 8);
    key.castShadow = true;
    this.scene.add(key);

    const floor = new THREE.Mesh(
      new THREE.BoxGeometry(this.boardSize, 0.26, this.boardSize),
      new THREE.MeshStandardMaterial({ color: 0x101a25, roughness: 0.9 })
    );
    floor.position.y = -0.22;
    floor.receiveShadow = true;
    this.scene.add(floor);
    this.scene.add(new THREE.GridHelper(this.boardSize, this.boardSize, 0x49b6e5, 0x263d5b));

    const wallGeometry = new THREE.BoxGeometry(this.boardSize + 1, 0.7, 0.34);
    const sideGeometry = new THREE.BoxGeometry(0.34, 0.7, this.boardSize + 1);
    [
      [wallGeometry, 0, this.half + 0.55],
      [wallGeometry, 0, -this.half - 0.55],
      [sideGeometry, this.half + 0.55, 0],
      [sideGeometry, -this.half - 0.55, 0]
    ].forEach(([geometry, x, z]) => {
      const wall = new THREE.Mesh(geometry, this.wallMaterial);
      wall.position.set(x, 0.12, z);
      wall.castShadow = true;
      wall.receiveShadow = true;
      this.scene.add(wall);
    });

    this.foodMesh = new THREE.Mesh(new THREE.IcosahedronGeometry(0.48, 1), this.foodMaterial);
    this.foodMesh.castShadow = true;
    this.scene.add(this.foodMesh);
  }

  bindInput() {
    window.addEventListener("keydown", (event) => {
      const key = event.key.toLowerCase();
      if (key === " " || key === "spacebar") {
        event.preventDefault();
        this.togglePause();
        return;
      }
      if (key === "r") {
        this.startGame();
        return;
      }
      const directions = {
        arrowup: { x: 0, z: -1 },
        w: { x: 0, z: -1 },
        arrowdown: { x: 0, z: 1 },
        s: { x: 0, z: 1 },
        arrowleft: { x: -1, z: 0 },
        a: { x: -1, z: 0 },
        arrowright: { x: 1, z: 0 },
        d: { x: 1, z: 0 }
      };
      if (directions[key]) {
        event.preventDefault();
        if (!this.started || this.gameOver) this.startGame();
        this.setDirection(directions[key]);
      }
    });

    restartButton.addEventListener("click", () => this.startGame());
    window.addEventListener("resize", () => this.resize());
  }

  setDirection(next) {
    if (next.x + this.direction.x === 0 && next.z + this.direction.z === 0) return;
    this.nextDirection = next;
  }

  startGame() {
    this.restartGame();
    this.started = true;
    this.paused = false;
    this.gameOver = false;
    overlay.classList.add("hidden");
  }

  restartGame() {
    this.direction = { x: 1, z: 0 };
    this.nextDirection = { x: 1, z: 0 };
    this.snake = [
      { x: -1, z: 0 },
      { x: -2, z: 0 },
      { x: -3, z: 0 }
    ];
    this.score = 0;
    this.food = this.spawnFood();
    this.syncMeshes();
    this.updateHud();
  }

  togglePause() {
    if (!this.started || this.gameOver) return;
    this.paused = !this.paused;
    if (this.paused) {
      this.showOverlay("Paused", "Press Space to resume or R to restart.", "Resume");
    } else {
      overlay.classList.add("hidden");
    }
  }

  spawnFood() {
    let next;
    do {
      next = {
        x: Math.floor(Math.random() * this.boardSize) - this.half,
        z: Math.floor(Math.random() * this.boardSize) - this.half
      };
    } while (this.snake.some((segment) => segment.x === next.x && segment.z === next.z));
    return next;
  }

  updateGame(time) {
    if (!this.started || this.paused || this.gameOver) return;
    const speedMultiplier = 1 + Math.min(this.score, 14) * 0.055;
    const stepMs = this.baseStepMs / speedMultiplier;
    if (time - this.lastStepAt < stepMs) return;
    this.lastStepAt = time;

    this.direction = this.nextDirection;
    const head = this.snake[0];
    const nextHead = { x: head.x + this.direction.x, z: head.z + this.direction.z };

    if (this.isWallCollision(nextHead) || this.isSelfCollision(nextHead)) {
      this.endGame();
      return;
    }

    this.snake.unshift(nextHead);
    if (nextHead.x === this.food.x && nextHead.z === this.food.z) {
      this.score += 1;
      this.best = Math.max(this.best, this.score);
      localStorage.setItem("snakeArenaBest", String(this.best));
      this.food = this.spawnFood();
    } else {
      this.snake.pop();
    }
    this.updateHud();
    this.syncMeshes();
  }

  isWallCollision(point) {
    return point.x < -this.half || point.x > this.half || point.z < -this.half || point.z > this.half;
  }

  isSelfCollision(point) {
    return this.snake.some((segment) => segment.x === point.x && segment.z === point.z);
  }

  endGame() {
    this.gameOver = true;
    this.started = false;
    this.showOverlay("Game over", "Final score: " + this.score + ". Press R or restart to play again.", "Restart");
  }

  syncMeshes() {
    while (this.snakeMeshes.length < this.snake.length) {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.82, 0.82, 0.82), this.snakeMaterial);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.scene.add(mesh);
      this.snakeMeshes.push(mesh);
    }
    this.snakeMeshes.forEach((mesh, index) => {
      const segment = this.snake[index];
      if (!segment) {
        mesh.visible = false;
        return;
      }
      mesh.visible = true;
      mesh.material = index === 0 ? this.headMaterial : this.snakeMaterial;
      mesh.position.set(segment.x * this.cellSize, 0.36, segment.z * this.cellSize);
      mesh.scale.setScalar(Math.max(0.58, 1 - index * 0.025));
    });
    this.renderFood();
  }

  renderSnake(time) {
    this.snakeMeshes.forEach((mesh, index) => {
      if (!mesh.visible) return;
      mesh.rotation.y = Math.sin(time * 0.004 + index) * 0.12;
      mesh.position.y = 0.38 + Math.sin(time * 0.006 + index) * 0.025;
    });
  }

  renderFood() {
    this.foodMesh.position.set(this.food.x, 0.55, this.food.z);
  }

  updateHud() {
    scoreLabel.textContent = String(this.score);
    bestLabel.textContent = String(this.best);
    speedLabel.textContent = (1 + Math.min(this.score, 14) * 0.055).toFixed(1) + "x";
  }

  showOverlay(title, copy, buttonText) {
    overlayTitle.textContent = title;
    overlayCopy.textContent = copy;
    restartButton.textContent = buttonText;
    overlay.classList.remove("hidden");
  }

  resize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  animate(time) {
    requestAnimationFrame((nextTime) => this.animate(nextTime));
    this.updateGame(time);
    this.renderSnake(time);
    this.foodMesh.rotation.y += 0.035;
    this.foodMesh.rotation.x += 0.018;
    this.camera.position.x = Math.sin(time * 0.00018) * 3 + 10;
    this.camera.position.z = Math.cos(time * 0.00016) * 2 + 15;
    this.camera.lookAt(0, 0, 0);
    this.renderer.render(this.scene, this.camera);
  }
}

new SnakeGame();
`;

  return {
    title: options.title ?? "Playable Three.js snake implementation",
    summary:
      options.summary ??
      `Creates a preview-ready HTML, CSS, and JavaScript Three.js snake game for: ${userPrompt}`,
    riskLevel: options.riskLevel ?? "medium",
    filesChanged: [
      { path: "index.html", changeType: "create", explanation: "Main HTML shell, HUD, overlay, controls, and module script." },
      { path: "styles.css", changeType: "create", explanation: "Responsive arcade layout, HUD, overlay, controls, and canvas styling." },
      { path: "main.js", changeType: "create", explanation: "Playable Three.js snake game with movement, food, scoring, collision, restart, and rendering." }
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
      `@@ -0,0 +1,${html.trimEnd().split("\n").length} @@`,
      ...html.trimEnd().split("\n").map((line) => `+${line}`),
      "diff --git a/styles.css b/styles.css",
      "new file mode 100644",
      "index 0000000..1111111",
      "--- /dev/null",
      "+++ b/styles.css",
      `@@ -0,0 +1,${css.trimEnd().split("\n").length} @@`,
      ...css.trimEnd().split("\n").map((line) => `+${line}`),
      "diff --git a/main.js b/main.js",
      "new file mode 100644",
      "index 0000000..1111111",
      "--- /dev/null",
      "+++ b/main.js",
      `@@ -0,0 +1,${js.trimEnd().split("\n").length} @@`,
      ...js.trimEnd().split("\n").map((line) => `+${line}`)
    ].join("\n"),
    requiresApproval: true,
    status: "proposed"
  };
}
