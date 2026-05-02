import assert from "node:assert/strict";
import test from "node:test";
import { ReviewerAgent } from "../agents/workers/ReviewerAgent.js";
import { createThreeJsSnakeProposal, validateThreeJsSnakeProposal } from "../mock/threeJsSnake.js";

test("ReviewerAgent blocks placeholder patch content", () => {
  const reviewer = new ReviewerAgent();
  const result = reviewer.review(
    "session_test",
    [
      {
        id: "patch_stub",
        sessionId: "session_test",
        title: "Stub patch",
        summary: "placeholder",
        riskLevel: "low",
        filesChanged: [{ path: "main.js", changeType: "create", explanation: "stub" }],
        artifacts: [{ path: "main.js", content: "// TODO placeholder\n" }],
        unifiedDiff: "",
        requiresApproval: true,
        status: "proposed",
        createdAt: new Date().toISOString()
      }
    ],
    [],
    []
  );

  assert.equal(result.status, "needs_changes");
  assert.match(result.findings.join("\n"), /placeholder/);
});

test("Three.js snake validator blocks broken UMD bundle output", () => {
  const proposal = createThreeJsSnakeProposal("use 3 agents to make a html css js 3d snake game with threejs");
  const broken = {
    ...proposal,
    title: "Broken snake",
    artifacts: proposal.artifacts?.map((artifact) =>
      artifact.path === "index.html"
        ? {
            ...artifact,
            content: artifact.content.replace(
              '<script type="module" src="./main.js"></script>',
              '<script src="https://unpkg.com/three@0.165.0/build/three.min.js"></script><script src="./main.js"></script>'
            )
          }
        : artifact
    )
  };

  const validation = validateThreeJsSnakeProposal(broken);
  assert.equal(validation.valid, false);
  assert.match(validation.blockingReasons.join("\n"), /three\.min\.js/);
});

test("Three.js snake validator accepts the centralized playable fixture", () => {
  const proposal = createThreeJsSnakeProposal("use 3 agents to make a html css js 3d snake game with threejs");
  const validation = validateThreeJsSnakeProposal(proposal);

  assert.equal(validation.valid, true);
  assert.match(validation.reviewerNotes.join("\n"), /movement/);
});
