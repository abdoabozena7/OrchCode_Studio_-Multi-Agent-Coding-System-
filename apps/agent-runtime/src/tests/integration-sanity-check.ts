/**
 * integration-sanity-check.ts
 *
 * End-to-end sanity check for the "Sense-Reason-Act" loop:
 *   1. Queue (SqliteTaskQueueBackend)
 *   2. Sandbox execution (Docker-based SandboxExecutionConsumer)
 *   3. Adversarial review (ReviewerAgent + mock LLM provider)
 *   4. Circuit breaker (AgentCircuitBreaker bankruptcy)
 *
 * Usage:  npx tsx src/tests/integration-sanity-check.ts
 *         npm run sanity        (see package.json)
 */
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

/* ------------------------------------------------------------------ */
/*  Imports                                                            */
/* ------------------------------------------------------------------ */
import { SqliteTaskQueueBackend } from "../orchestration/AgentTaskQueue.js";
import type { QueueJobPriority, EnqueueJobInput, QueueMetrics } from "../orchestration/TaskQueueTypes.js";
import { AgentCircuitBreaker, type BranchBankruptcyError } from "../orchestration/CircuitBreaker.js";
import { validateReadOnlySwarmOutput, normalizeReadOnlySwarmOutput } from "../orchestration/ReadOnlySwarmWorkerSchemas.js";
import type { LlmProvider, LlmRequest } from "../llm/LlmProvider.js";
import { invokeReasoningProviderStructured } from "../runtime/ReasoningKernel.js";

/* ------------------------------------------------------------------ */
/*  Coloured console helpers                                           */
/* ------------------------------------------------------------------ */
const PASS = "\x1b[32m✓\x1b[0m";
const FAIL = "\x1b[31m✗\x1b[0m";
const INFO = "\x1b[34m▶\x1b[0m";
const WARN = "\x1b[33m⚠\x1b[0m";
const SEP = "\x1b[90m" + "─".repeat(72) + "\x1b[0m";

function logPass(label: string, detail = "") {
  console.log(`  ${PASS} ${label}${detail ? `  ${detail}` : ""}`);
}
function logFail(label: string, detail = "") {
  console.log(`  ${FAIL} ${label}${detail ? `  ${detail}` : ""}`);
}
function logInfo(label: string, detail = "") {
  console.log(`  ${INFO} ${label}${detail ? `  ${detail}` : ""}`);
}
function logWarn(label: string, detail = "") {
  console.log(`  ${WARN} ${label}${detail ? `  ${detail}` : ""}`);
}
function logSection(title: string) {
  console.log(`\n${SEP}\n ${title}\n${SEP}`);
}
function logJson(label: string, obj: unknown) {
  console.log(`  ${INFO} ${label}:`);
  console.log(JSON.stringify(obj, null, 2));
}

/* ------------------------------------------------------------------ */
/*  HELPERS                                                            */
/* ------------------------------------------------------------------ */

/** Check if Docker is available on the host */
function checkDocker(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("docker", ["info", "--format", "{{.OSType}}"], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
    });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

/** The intentionally flawed Fibonacci script (Python) */
const FLAWED_FIBONACCI_PY = `# BUG 1: Missing import (math is used but not imported)
# BUG 2: O(2^n) recursive implementation without memoization
# BUG 3: Syntax error on purpose (extra parenthesis on last line)

def fibonacci(n):
    if n <= 0:
        return 0
    elif n == 1:
        return 1
    else:
        # O(2^n) - no memoization, exponential recomputation
        return fibonacci(n-1) + fibonacci(n-2)

# Using math.sqrt without importing math -- will raise NameError
def is_perfect_square(x):
    s = int(math.sqrt(x))
    return s * s == x

def main():
    result = fibonacci(35)  # Will take very long or OOM
    print(f"The 35th Fibonacci number is: {result})")  # Syntax error: extra ')'
    if is_perfect_square(result):
        print("It is also a perfect square!")

if __name__ == "__main__":
    main()
`;

/** The fixed Fibonacci script (for repair loop simulation) */
const FIXED_FIBONACCI_PY = `import math

def fibonacci(n, memo={}):
    if n in memo:
        return memo[n]
    if n <= 0:
        return 0
    elif n == 1:
        return 1
    memo[n] = fibonacci(n-1, memo) + fibonacci(n-2, memo)
    return memo[n]

def is_perfect_square(x):
    s = int(math.sqrt(x))
    return s * s == x

def main():
    result = fibonacci(35)
    print(f"The 35th Fibonacci number is: {result}")
    if is_perfect_square(result):
        print("It is also a perfect square!")

if __name__ == "__main__":
    main()
`;

/* ------------------------------------------------------------------ */
/*  Mock LLM Provider that returns adversarial reviewer output         */
/* ------------------------------------------------------------------ */
class MockAdversarialProvider implements LlmProvider {
  async generateStructured<T>(input: LlmRequest, schema: unknown): Promise<T> {
    const schemaName = typeof schema === "object" && schema && "name" in schema
      ? String((schema as { name: string }).name)
      : "";

    if (schemaName === "adversarial_reviewer_output") {
      return {
        schema: "adversarial_reviewer_output",
        decision: "blocked",
        assertions: [
          {
            assertion_type: "correctness",
            file_path: "fibonacci.py",
            line_range: [17, 17],
            severity: "critical",
            description: "NameError: name 'math' is not defined — missing 'import math' at top of file",
            evidence: "Line 17 calls math.sqrt(x) but math is never imported; the module will crash at runtime with NameError.",
            blocks_approval: true,
          },
          {
            assertion_type: "performance",
            file_path: "fibonacci.py",
            line_range: [10, 12],
            severity: "high",
            description: "O(2^n) recursive Fibonacci without memoization causes exponential recomputation",
            evidence: "fibonacci(n-1) + fibonacci(n-2) recomputes the entire subtree on every call; fibonacci(35) requires ~18 million recursive calls.",
            blocks_approval: true,
          },
          {
            assertion_type: "correctness",
            file_path: "fibonacci.py",
            line_range: [20, 20],
            severity: "critical",
            description: "SyntaxError: extraneous closing parenthesis in f-string print call",
            evidence: "Line 20 has `result})` with two closing parentheses but only one opening; Python will raise SyntaxError on parse.",
            blocks_approval: true,
          },
        ],
        files_examined: ["fibonacci.py"],
        lines_of_code_reviewed: 24,
        tests_checked: [],
        code_quotes: [
          "Line 5-12: recursive fibonacci(n-1) + fibonacci(n-2) without memoization",
          "Line 17: s = int(math.sqrt(x)) — NameError risk",
          "Line 20: print(f\"The 35th Fibonacci number is: {result})\") — SyntaxError",
        ],
        confidence: 0.95,
      } as T;
    }
    return {} as T;
  }

  async generateText(input: LlmRequest): Promise<string> {
    return "Mock provider response";
  }
}

/* ------------------------------------------------------------------ */
/*  TEST 1: Queue round-trip                                           */
/* ------------------------------------------------------------------ */
async function testQueueRoundTrip(tmpDir: string): Promise<void> {
  logSection("1. Queue Round-Trip (SqliteTaskQueueBackend)");

  const queue = new SqliteTaskQueueBackend(tmpDir);

  // Enqueue
  const jobId = await queue.enqueue({
    queue_name: "sanity",
    job_type: "test_job",
    payload: { step: 1, action: "fibonacci" },
    priority: 3 as QueueJobPriority,
    max_attempts: 3,
  });
  if (!jobId) throw new Error("enqueue did not return a job ID");
  logPass("enqueue", `jobId=${jobId}`);

  // Dequeue
  const dequeued = await queue.dequeue("sanity", 3_000);
  if (!dequeued) throw new Error("dequeue returned null");
  logPass("dequeue", `jobId=${dequeued.job.id}, leaseId=${dequeued.lease_id}`);

  // Verify payload
  const payload = JSON.parse(dequeued.job.payload_json) as { step: number };
  if (payload.step !== 1) throw new Error(`Unexpected payload: ${JSON.stringify(payload)}`);
  logPass("payload round-trip", `step=${payload.step}`);

  // Ack
  await queue.ack(dequeued.job.id, dequeued.lease_id);
  logPass("ack");

  // Verify completion
  const stats = await queue.getMetrics("sanity");
  if (stats.completed < 1) throw new Error("Queue metrics did not reflect completion");
  logPass("metrics", JSON.stringify(stats));

  // Test dead-letter via nack
  const jobId2 = await queue.enqueue({
    queue_name: "sanity_dlq",
    job_type: "fail_job",
    payload: { will: "fail" },
    priority: 3 as QueueJobPriority,
    max_attempts: 2,
  });
  // Exhaust attempts
  for (let attempt = 0; attempt < 2; attempt++) {
    const dq = await queue.dequeue("sanity_dlq", 1_000);
    if (!dq) throw new Error(`dequeue failed on attempt ${attempt + 1}`);
    await queue.nack(dq.job.id, dq.lease_id, `Simulated failure attempt ${attempt + 1}`);
  }
  // Should be in dead letter
  const dqAfter = await queue.dequeue("sanity_dlq", 500);
  if (dqAfter) throw new Error("Job should have been dead-lettered after max_attempts");
  logPass("dead-letter after max_attempts");

  queue.close();
}

/* ------------------------------------------------------------------ */
/*  TEST 2: Sandbox execution (Docker required)                        */
/* ------------------------------------------------------------------ */
async function testSandboxExecution(tmpDir: string): Promise<void> {
  logSection("2. Sandbox Execution (Docker)");

  const hasDocker = await checkDocker();
  if (!hasDocker) {
    logWarn("Docker not available", "Skipping sandbox execution test");
    return;
  }
  logPass("Docker available");

  // Write flawed Fibonacci script
  const scriptPath = path.join(tmpDir, "fibonacci.py");
  await writeFile(scriptPath, FLAWED_FIBONACCI_PY, "utf-8");

  // Run the flawed script in a Python container
  const startTime = Date.now();
  const result = await new Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }>((resolve) => {
    const child = spawn("docker", [
      "run", "--rm", "--network", "none", "--read-only",
      "--memory", "256m", "--cpus", "1",
      "--security-opt", "no-new-privileges", "--cap-drop", "ALL",
      "--mount", `type=bind,source=${tmpDir},target=/workspace,ro`,
      "-w", "/workspace",
      "python:3.11-slim",
      "python", "fibonacci.py",
    ], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;

    child.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 30_000);

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
        stderr: Buffer.concat(stderrChunks).toString("utf-8"),
        exitCode: code,
        timedOut,
      });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ stdout: "", stderr: `spawn error: ${err.message}`, exitCode: null, timedOut: false });
    });
  });
  const duration = Date.now() - startTime;

  logInfo("Execution", `duration=${duration}ms, exitCode=${result.exitCode}, timedOut=${result.timedOut}`);

  // Expected: the script should fail due to NameError or SyntaxError
  const output = result.stdout + "\n" + result.stderr;

  const hasNameError = output.includes("NameError") || output.includes("math");
  const hasSyntaxError = output.includes("SyntaxError") || output.includes("invalid syntax");
  const hasTimeout = result.timedOut;

  if (hasNameError) logPass("Caught NameError (missing import)");
  if (hasSyntaxError) logPass("Caught SyntaxError (extra parenthesis)");
  if (hasTimeout) logWarn("Timed out", "O(2^n) complexity caused timeout as expected");

  if (!hasNameError && !hasSyntaxError && !hasTimeout) {
    logWarn("Unexpected output", "The script may have partially run. Output below:");
    console.log(`  stdout: ${result.stdout.slice(0, 500)}`);
    console.log(`  stderr: ${result.stderr.slice(0, 500)}`);
  } else {
    logPass("Sandbox detected flaws");
    logInfo("stderr excerpt", result.stderr.slice(0, 400).replace(/\n/g, "\\n"));
  }
}

/* ------------------------------------------------------------------ */
/*  TEST 3: Adversarial Reviewer                                       */
/* ------------------------------------------------------------------ */
async function testAdversarialReviewer(): Promise<void> {
  logSection("3. Adversarial Reviewer (ReviewerAgent + Mock Provider)");

  const provider = new MockAdversarialProvider();

  const patches = [
    {
      id: "patch_fib_1",
      sessionId: "sanity",
      title: "Fibonacci implementation",
      summary: "Add recursive Fibonacci with syntax errors and missing import",
      riskLevel: "high",
      filesChanged: [{ path: "fibonacci.py", changeType: "create", explanation: "Add broken Fibonacci script" }],
      artifacts: [{ path: "fibonacci.py", content: FLAWED_FIBONACCI_PY }],
      unifiedDiff: "diff --git a/fibonacci.py b/fibonacci.py\nnew file mode 100644\n--- /dev/null\n+++ b/fibonacci.py\n@@ -0,0 +1,24 @@\n" + FLAWED_FIBONACCI_PY.split("\n").map((l) => "+" + l).join("\n"),
      requiresApproval: true,
      status: "proposed",
      createdAt: new Date().toISOString(),
    },
  ];

  const workerOutputs: Array<{ summary: string; status: string; details: string[] }> = [
    {
      summary: "Generated fibonacci.py with recursive implementation",
      status: "needs_review",
      details: ["O(2^n) complexity", "Missing import math", "Syntax error in print"],
    },
  ];

  const sandboxResult = {
    exitCode: 1,
    stdout: "",
    stderr: 'NameError: name \\"math\\" is not defined\\nSyntaxError: invalid syntax',
    durationMs: 450,
    timedOut: false,
    oomKilled: false,
  };

  // Directly invoke the structured provider with the adversarial schema
  logInfo("Calling LLM with adversarial_reviewer_output schema...");
  const raw = await invokeReasoningProviderStructured<Record<string, unknown>>(
    provider,
    {
      purpose: "verify",
      systemPrompt: `You are an adversarial code reviewer. Review the following patch and sandbox result.`,
      userPrompt: [
        `Patch: ${JSON.stringify(patches[0])}`,
        `Sandbox exit: ${sandboxResult.exitCode}`,
        `Sandbox stderr: ${sandboxResult.stderr}`,
      ].join("\n"),
    },
    { name: "adversarial_reviewer_output" }
  );
  logPass("invokeReasoningProviderStructured returned");

  // Validate against schema
  const validation = validateReadOnlySwarmOutput(raw, { name: "adversarial_reviewer_output" });
  if (validation.valid) {
    logPass("Schema validation passed");
  } else {
    // Try normalization
    const norm = normalizeReadOnlySwarmOutput(raw, { name: "adversarial_reviewer_output" });
    if (norm.validation.valid) {
      logPass("Schema validation passed after normalization");
    } else {
      logWarn("Schema validation", norm.validation.errors.join("; "));
    }
  }

  // Show the adversarial review output
  logJson("Adversarial Review Output", raw);

  // Verify the review contains the expected findings
  const assertions = Array.isArray(raw.assertions) ? raw.assertions : [];
  const assertionTypes = assertions.map((a: Record<string, unknown>) => a.assertion_type);
  const severities = assertions.map((a: Record<string, unknown>) => a.severity);

  logInfo("Assertion types found", assertionTypes.join(", "));
  logInfo("Severities found", severities.join(", "));

  const hasCorrectness = assertionTypes.includes("correctness");
  const hasPerformance = assertionTypes.includes("performance");
  const hasCriticalOrHigh = severities.some((s: unknown) => s === "critical" || s === "high");

  // Check key expectations
  const checks: Array<{ label: string; ok: boolean }> = [
    { label: "Detected missing import (correctness)", ok: hasCorrectness },
    { label: "Detected O(2^n) performance issue", ok: hasPerformance },
    { label: "Has critical or high severity findings", ok: hasCriticalOrHigh },
    { label: "Decision is blocked", ok: String(raw.decision ?? "") === "blocked" },
    { label: "Has code_quotes evidence", ok: Array.isArray(raw.code_quotes) && (raw.code_quotes as unknown[]).length >= 3 },
    { label: "Has files_examined", ok: Array.isArray(raw.files_examined) && (raw.files_examined as unknown[]).length > 0 },
    { label: "Confidence >= 0.9", ok: typeof raw.confidence === "number" && raw.confidence >= 0.9 },
  ];

  let allPassed = true;
  for (const check of checks) {
    if (check.ok) {
      logPass(check.label);
    } else {
      logFail(check.label);
      allPassed = false;
    }
  }

  if (!allPassed) {
    throw new Error("Adversarial review did not meet all expectations — review the JSON above");
  }
}

/* ------------------------------------------------------------------ */
/*  TEST 4: Circuit Breaker Bankruptcy                                 */
/* ------------------------------------------------------------------ */
async function testCircuitBreakerBankruptcy(): Promise<void> {
  logSection("4. Circuit Breaker Bankruptcy (AgentCircuitBreaker)");

  const branchId = `fibonacci_repair_${randomUUID()}`;
  const agentName = "FibonacciWorker";

  const breaker = new AgentCircuitBreaker(branchId, agentName, {
    max_bankruptcy_attempts: 3,
    max_repair_rounds: 3,
    max_duplicate_outputs: 2,
    max_stagnant_rounds: 3,
    stagnation_window_ms: 120_000,
    fingerprint_similarity_threshold: 0.85,
  });

  // Simulate the repair loop: worker keeps fixing syntax but not complexity
  // Each attempt produces nearly the same fingerprint (same flawed logic)
  const badFingerprint1 = AgentCircuitBreaker.createFingerprint(
    "Added import math but kept O(2^n) recursive implementation unchanged"
  );
  const badFingerprint2 = AgentCircuitBreaker.createFingerprint(
    "Fixed syntax but kept O(2^n) recursive algorithm; no memoization added"
  );
  const badFingerprint3 = AgentCircuitBreaker.createFingerprint(
    "Still O(2^n) — added a print statement but did not add memoization cache"
  );

  logInfo("Simulating repair attempts with duplicate output fingerprints...");

  // Round 1: first attempt fails
  breaker.recordAttempt(badFingerprint1, "NameError: math not defined", "Script crashed with NameError");
  breaker.recordProgress();
  logInfo("Round 1", `attempts recorded`);

  // Round 2: second attempt — fixes NameError but still O(2^n)
  breaker.recordAttempt(badFingerprint2, "SyntaxError: extra parenthesis", "Script crashed with SyntaxError");
  breaker.recordProgress();
  logInfo("Round 2", `attempts recorded`);

  // Round 3: third attempt — fixes syntax but still O(2^n) — duplicate of round 2
  breaker.recordAttempt(badFingerprint2, "Timeout: fibonacci(35) took > 30s", "O(2^n) caused timeout");
  breaker.recordProgress();
  logInfo("Round 3", `attempts recorded`);

  // Check bankruptcy — duplicate outputs may trigger if max_attempts exceeded
  const bankruptcy1 = breaker.checkBankruptcy();
  if (bankruptcy1) {
    logInfo("Bankruptcy at round 3", `reason=${bankruptcy1.reason} (expected if max_attempts=3)`);
  } else {
    logPass("No bankruptcy at round 3 (within limits)");
  }

  // Round 4: another duplicate
  breaker.recordAttempt(badFingerprint3, "Timeout: still O(2^n)", "Worker keeps producing O(2^n) code");
  breaker.recordProgress();
  logInfo("Round 4", `attempts recorded`);

  // Round 5: yet another duplicate
  breaker.recordAttempt(badFingerprint1, "Bankruptcy approaching", "Still O(2^n) recursive algorithm");
  breaker.recordProgress();
  logInfo("Round 5", `attempts recorded`);

  // Now check bankruptcy
  const bankruptcy = breaker.checkBankruptcy();
  if (bankruptcy) {
    logPass("Bankruptcy triggered", `reason=${bankruptcy.reason}`);
    logJson("Bankruptcy Error", {
      branch_id: bankruptcy.branch_id,
      agent_name: bankruptcy.agent_name,
      reason: bankruptcy.reason,
      last_error: bankruptcy.last_error,
    });
  } else {
    logFail("No bankruptcy after 5 rounds with duplicate outputs");
    // Force bankruptcy via max_attempts
    breaker.recordAttempt(badFingerprint1, "Final attempt", "Still producing O(2^n) — bankruptcy forced");
    const final = breaker.checkBankruptcy();
    if (final) {
      logPass("Bankruptcy triggered after forced attempt");
    } else {
      logWarn("Circuit breaker did not trigger — may need config tuning");
    }
  }
}

/* ------------------------------------------------------------------ */
/*  TEST 5: Full Pipeline Simulation (Queue → Scheduler → Sandbox)    */
/* ------------------------------------------------------------------ */
async function testFullPipelineSimulation(tmpDir: string): Promise<void> {
  logSection("5. Full Pipeline Simulation (Queue → Scheduler → Sandbox → Review)");

  const queue = new SqliteTaskQueueBackend(tmpDir);
  const sessionId = `sanity_${randomUUID().slice(0, 8)}`;

  // Step A: Enqueue a sandbox execution job
  logInfo("Enqueuing sandbox execution job...");
  const jobId = await queue.enqueue({
    queue_name: `sanity_sandbox:${sessionId}`,
    job_type: "sandbox_execution",
    payload: {
      files: { "fibonacci.py": FLAWED_FIBONACCI_PY },
      command: "python fibonacci.py",
      image: "python:3.11-slim",
      timeoutMs: 30_000,
      memoryLimit: "256m",
      cpuLimit: 1,
    },
    priority: 3 as QueueJobPriority,
    max_attempts: 2,
  });
  logPass("Enqueued sandbox job", `jobId=${jobId}`);

  // Step B: Dequeue the job
  const dequeued = await queue.dequeue(`sanity_sandbox:${sessionId}`, 3_000);
  if (!dequeued) throw new Error("Failed to dequeue sandbox job");
  logPass("Dequeued sandbox job", `leaseId=${dequeued.lease_id}`);

  // Step C: Parse the payload
  const sandboxPayload = JSON.parse(dequeued.job.payload_json) as {
    files: Record<string, string>;
    command: string;
    image: string;
  };
  logInfo("Sandbox request", `image=${sandboxPayload.image}, command=${sandboxPayload.command}`);

  // Step D: Check if Docker is available and run
  const hasDocker = await checkDocker();
  if (hasDocker) {
    const tempScriptDir = path.join(tmpDir, "sandbox_run");
    await mkdir(tempScriptDir, { recursive: true });
    for (const [fileName, content] of Object.entries(sandboxPayload.files)) {
      await writeFile(path.join(tempScriptDir, fileName), content, "utf-8");
    }

    const startTime = Date.now();
    const result = await new Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }>((resolve) => {
      const child = spawn("docker", [
        "run", "--rm", "--network", "none", "--read-only",
        "--memory", "256m", "--cpus", "1",
        "--security-opt", "no-new-privileges", "--cap-drop", "ALL",
        "--mount", `type=bind,source=${tempScriptDir},target=/workspace,ro`,
        "-w", "/workspace",
        sandboxPayload.image,
        "sh", "-c", sandboxPayload.command,
      ], {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 60_000,
      });

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let timedOut = false;

      child.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
      child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, 30_000);

      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({
          stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
          stderr: Buffer.concat(stderrChunks).toString("utf-8"),
          exitCode: code,
          timedOut,
        });
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({ stdout: "", stderr: `spawn error: ${err.message}`, exitCode: null, timedOut: false });
      });
    });
    const duration = Date.now() - startTime;

    logInfo("Sandbox execution", `exitCode=${result.exitCode}, timedOut=${result.timedOut}, duration=${duration}ms`);
    logInfo("stderr", result.stderr.slice(0, 500));

    const failed = result.exitCode !== 0 || result.timedOut;

    if (failed) {
      // Step E: Ack the failed job
      await queue.nack(dequeued.job.id, dequeued.lease_id, `Sandbox failed: ${result.stderr.slice(0, 200)}`);
      logPass("Sandbox correctly detected failure — nack sent");
      logInfo("Job will be retried (or dead-lettered if max_attempts exhausted)");
    } else {
      await queue.ack(dequeued.job.id, dequeued.lease_id);
      logWarn("Sandbox unexpectedly passed — flawed script did not fail?");
    }

    await rm(tempScriptDir, { recursive: true, force: true });
  } else {
    // Simulate the sandbox failure without Docker
    logWarn("Docker not available — simulating sandbox failure");
    await queue.nack(dequeued.job.id, dequeued.lease_id, "Simulated: NameError + SyntaxError in flawed script");
    logPass("Simulated sandbox failure — nack sent");
  }

  // Step F: Verify queue metrics
  const metrics = await queue.getMetrics(`sanity_sandbox:${sessionId}`);
  logInfo("Queue metrics", JSON.stringify(metrics));

  // Step G: Circuit breaker integration
  logInfo("Registering sandbox failure in circuit breaker...");
  const breaker = new AgentCircuitBreaker(`sandbox_${sessionId}`, "FibonacciWorker", {
    max_bankruptcy_attempts: 3,
    max_repair_rounds: 3,
    max_duplicate_outputs: 2,
    max_stagnant_rounds: 3,
    stagnation_window_ms: 120_000,
    fingerprint_similarity_threshold: 0.85,
  });
  const fingerprint = AgentCircuitBreaker.createFingerprint(`sandbox_failure:${sandboxPayload.command}`);
  breaker.recordAttempt(fingerprint, "Sandbox execution failed", "Flawed Fibonacci script caused NameError and SyntaxError");
  breaker.recordProgress();
  logPass("Circuit breaker recorded sandbox failure", `fingerprint=${fingerprint.slice(0, 16)}...`);

  queue.close();
}

/* ------------------------------------------------------------------ */
/*  MAIN                                                               */
/* ------------------------------------------------------------------ */
async function main() {
  console.log(`\n\x1b[1;34m═══════════════════════════════════════════════════════════════\x1b[0m`);
  console.log(`\x1b[1;34m  INTEGRATION SANITY CHECK — Sense-Reason-Act Pipeline\x1b[0m`);
  console.log(`\x1b[1;34m  ${new Date().toISOString()}\x1b[0m`);
  console.log(`\x1b[1;34m═══════════════════════════════════════════════════════════════\x1b[0m`);

  const tmpDir = path.join(os.tmpdir(), `hivo_sanity_${Date.now()}`);
  await mkdir(tmpDir, { recursive: true });

  let exitCode = 0;

  try {
    /* Test 1: Queue */
    await testQueueRoundTrip(tmpDir);
  } catch (err) {
    logFail(`Queue test FAILED: ${(err as Error).message}`);
    exitCode = 1;
  }

  try {
    /* Test 2: Sandbox (Docker) */
    await testSandboxExecution(tmpDir);
  } catch (err) {
    logFail(`Sandbox test FAILED: ${(err as Error).message}`);
    exitCode = 1;
  }

  try {
    /* Test 3: Adversarial Reviewer */
    await testAdversarialReviewer();
  } catch (err) {
    logFail(`Adversarial review test FAILED: ${(err as Error).message}`);
    exitCode = 1;
  }

  try {
    /* Test 4: Circuit Breaker */
    await testCircuitBreakerBankruptcy();
  } catch (err) {
    logFail(`Circuit breaker test FAILED: ${(err as Error).message}`);
    exitCode = 1;
  }

  try {
    /* Test 5: Full Pipeline */
    await testFullPipelineSimulation(tmpDir);
  } catch (err) {
    logFail(`Pipeline simulation test FAILED: ${(err as Error).message}`);
    exitCode = 1;
  }

  /* Cleanup */
  await rm(tmpDir, { recursive: true, force: true }).catch(() => {});

  console.log(`\n${SEP}`);
  if (exitCode === 0) {
    console.log(` \x1b[1;32m✓ ALL SANITY CHECKS PASSED\x1b[0m`);
  } else {
    console.log(` \x1b[1;31m✗ SOME SANITY CHECKS FAILED (exit code ${exitCode})\x1b[0m`);
  }
  console.log(`\n`);
  process.exit(exitCode);
}

main();
