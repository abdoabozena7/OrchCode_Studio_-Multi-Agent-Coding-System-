export const CROSSY_SINGLE_FILE_PROMPT = String.raw`You are a senior multi-agent game development system. Your mission is to build a complete 3D Crossy Road-style game using only ONE self-contained HTML file with Three.js.

The final output must be a single file named:

index.html

No external project structure. No separate JS files. No build tools. No npm. No backend.

You may use Three.js from CDN only.

Goal: Create a polished, playable, browser-based 3D Crossy Road game with modern visuals, smooth controls, procedural lanes, traffic, water, obstacles, scoring, restart flow, and clean code architecture inside one HTML file.

==================================================================== MULTI-AGENT WORKFLOW ====================================================================

Internally divide the work between these agents:

1. Game Design Agent: define the gameplay loop, movement, scoring, losing conditions, progression, obstacles, and game states.
2. Three.js Rendering Agent: build the scene, camera, lights, fog, shadows, materials, road, grass, water, vehicles, logs, coins, and UI from primitive geometry only.
3. Gameplay Logic Agent: implement grid movement, lane generation, moving hazards, collision detection, drowning, scoring, and high score.
4. Procedural Generation Agent: generate endless grass, road, highway, river, and optional train lanes; remove old lanes.
5. UI / UX Agent: create start, score, high score, game over, instructions, mobile controls, pause, and restart behavior.
6. Polish / Juice Agent: add hop animation, squash/stretch, smooth camera, water motion, particles, sound effects, fog, lighting, and readable UI.
7. QA Agent: verify direct browser opening, no missing imports or syntax errors, desktop/mobile controls, restart, score, collision, and stable performance.
8. Integration Agent: merge everything into one clean HTML file with organized classes and comments.

==================================================================== TECHNICAL REQUIREMENTS ====================================================================

Use HTML, CSS, JavaScript, and Three.js from this CDN only:
https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.min.js

Everything else must be written manually.

Do NOT use React, Vue, Angular, npm, Vite, Webpack, external models, external textures, external sound files, or multiple files.
The game must be fully contained in one HTML file.

==================================================================== GAMEPLAY REQUIREMENTS ====================================================================

The game must include a cute low-poly cube chicken made from Three.js primitives with body, head, eyes, and beak. It moves one tile at a time forward, backward, left, and right.

Desktop controls: Arrow keys and WASD.
Mobile controls: swipe controls or on-screen buttons.

Use a stable isometric camera that smoothly follows the player and shows upcoming lanes.

Create an infinite procedural tile/grid world with grass safe lanes, road lanes with vehicles, river lanes with moving logs, faster highways, and an optional warning train lane. Remove old lanes behind the player.

Cars and trucks move horizontally with different speeds, lengths, and colors. Vehicle collision causes game over.

On rivers, the player can stand on moving logs and must be carried with them. Water without a log causes game over, as does being carried outside the safe horizontal bounds.

Score increases only when reaching a new forward lane. Save high score with localStorage and display score and high score.

Game over occurs when hit, drowned, outside safe bounds, too far behind, or hit by an optional train. Show final score, high score, a restart button, and Space/Enter restart instructions.

Restart must reset player position, lanes, obstacles, score, camera, and game state. Difficulty increases gradually with faster vehicles, more dangerous lanes, more obstacles, and harder log patterns.

==================================================================== VISUAL STYLE ====================================================================

Use a polished low-poly toy style with colorful grass, roads, water motion, vehicles, logs, trees, rocks, bushes, soft shadows, directional and ambient lights, fog, a smooth camera, and modern CSS overlays.

==================================================================== CODE ARCHITECTURE ====================================================================

Organize JavaScript using readable classes inside the script tag: Game, Player, LaneManager, Lane, Vehicle, Log, InputManager, UIManager, AudioManager, and ParticleSystem. Keep important sections commented and maintainable.

==================================================================== COLLISION, PERFORMANCE, RESPONSIVE, AND POLISH ====================================================================

Use simple bounding boxes for vehicles and logs. Enforce world bounds. Reuse simple geometry and materials, remove old objects, use requestAnimationFrame, fill the full screen, handle resize, keep mobile text readable, and include smooth camera follow, player hop animation, vehicle shadows, animated water, particles, start/game-over screens, high-score persistence, and Web Audio effects if possible.

==================================================================== ACCEPTANCE TEST ====================================================================

Before final output, mentally verify: index.html opens directly; Three.js loads from the allowed CDN; the scene and player appear; keyboard and mobile controls work; camera follows; lanes generate; cars move; collisions and river/log logic work; scoring and high score work; restart works; there are no console errors; and all code is inside one HTML file.

==================================================================== OUTPUT FORMAT ====================================================================

Return ONLY the final complete code.
Do not explain. Do not summarize. Do not include markdown commentary outside the code. Do not say “here is the file”. Just output the full index.html content.

The final game must be complete, playable, and polished.`;
