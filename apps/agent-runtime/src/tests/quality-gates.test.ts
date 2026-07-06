import assert from "node:assert/strict";
import test from "node:test";
import { createThreeJsSnakeProposal, validateThreeJsSnakeProposal } from "../curatedProposals/threeJsSnake.js";
import { runQualityGates } from "../runtime/OrchestratedReviewService.js";

test("quality gates block placeholder patch content", () => {
  const results = runQualityGates(
    "session_test",
    "create a patch",
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
    true,
    []
  );
  const reviewerGate = results.find((result) => result.gateName === "ReviewerGate");

  assert.equal(reviewerGate?.status, "failed");
  assert.match(reviewerGate?.blockingReasons.join("\n") ?? "", /placeholder/);
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
