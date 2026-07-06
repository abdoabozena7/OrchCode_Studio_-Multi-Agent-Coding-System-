export type BankruptcyReason =
  | "max_attempts_exceeded"
  | "max_repair_loops_exceeded"
  | "duplicate_output_detected"
  | "stagnant_progress"
  | "structured_output_invalid_loop"
  | "manual_bankruptcy_declared";

export type BranchBankruptcyError = {
  kind: "branch_bankruptcy";
  branch_id: string;
  agent_name: string;
  reason: BankruptcyReason;
  attempt_count: number;
  max_bankruptcy_attempts: number;
  repair_rounds: number;
  max_repair_rounds: number;
  last_error: string;
  fingerprint_history: string[];
  reported_at: string;
};

export type CircuitBreakerConfig = {
  max_bankruptcy_attempts: number;
  max_repair_rounds: number;
  max_duplicate_outputs: number;
  max_stagnant_rounds: number;
  stagnation_window_ms: number;
  fingerprint_similarity_threshold: number;
};

export const DEFAULT_CIRCUIT_BREAKER_CONFIG: CircuitBreakerConfig = {
  max_bankruptcy_attempts: 5,
  max_repair_rounds: 2,
  max_duplicate_outputs: 2,
  max_stagnant_rounds: 3,
  stagnation_window_ms: 120_000,
  fingerprint_similarity_threshold: 0.85
};

export type AttemptRecord = {
  attempt_number: number;
  fingerprint: string;
  error: string;
  timestamp: number;
  output_summary: string;
};

export class AgentCircuitBreaker {
  private readonly attempts: AttemptRecord[] = [];
  private readonly fingerprints: string[] = [];
  private stagnantRoundCount = 0;
  private lastProgressTimestamp: number;

  constructor(
    public readonly branchId: string,
    public readonly agentName: string,
    private readonly config: CircuitBreakerConfig = DEFAULT_CIRCUIT_BREAKER_CONFIG
  ) {
    this.lastProgressTimestamp = Date.now();
  }

  recordAttempt(fingerprint: string, error: string, outputSummary: string): void {
    const attempt: AttemptRecord = {
      attempt_number: this.attempts.length + 1,
      fingerprint,
      error,
      timestamp: Date.now(),
      output_summary: outputSummary
    };
    this.attempts.push(attempt);
    this.fingerprints.push(fingerprint);
  }

  recordStagnantRound(): void {
    this.stagnantRoundCount += 1;
  }

  recordProgress(): void {
    this.stagnantRoundCount = 0;
    this.lastProgressTimestamp = Date.now();
  }

  get attemptCount(): number {
    return this.attempts.length;
  }

  get repairRoundCount(): number {
    return this.attempts.filter((a) => a.error.includes("repair")).length;
  }

  checkBankruptcy(): BranchBankruptcyError | null {
    const now = Date.now();

    if (this.attemptCount >= this.config.max_bankruptcy_attempts) {
      return this.buildError("max_attempts_exceeded", `Attempt count ${this.attemptCount} reached max ${this.config.max_bankruptcy_attempts}`);
    }

    const repairRounds = this.repairRoundCount;
    if (repairRounds >= this.config.max_repair_rounds) {
      return this.buildError("max_repair_loops_exceeded", `Repair loops ${repairRounds} reached max ${this.config.max_repair_rounds}`);
    }

    const duplicateOutputs = this.countDuplicateFingerprints();
    if (duplicateOutputs >= this.config.max_duplicate_outputs) {
      return this.buildError("duplicate_output_detected", `Duplicate output fingerprint seen ${duplicateOutputs} times`);
    }

    if (this.stagnantRoundCount >= this.config.max_stagnant_rounds) {
      return this.buildError("stagnant_progress", `Stagnant for ${this.stagnantRoundCount} rounds without meaningful progress`);
    }

    const elapsedSinceProgress = now - this.lastProgressTimestamp;
    if (elapsedSinceProgress > this.config.stagnation_window_ms && this.attemptCount > 0) {
      return this.buildError("stagnant_progress", `No progress for ${elapsedSinceProgress}ms (window: ${this.config.stagnation_window_ms}ms)`);
    }

    return null;
  }

  declareBankruptcy(reason: BankruptcyReason, detail: string): BranchBankruptcyError {
    return this.buildError(reason, detail);
  }

  private countDuplicateFingerprints(): number {
    const counts = new Map<string, number>();
    for (const fp of this.fingerprints) {
      counts.set(fp, (counts.get(fp) ?? 0) + 1);
    }
    let maxDupes = 0;
    for (const count of counts.values()) {
      maxDupes = Math.max(maxDupes, count);
    }
    return maxDupes;
  }

  private buildError(reason: BankruptcyReason, detail: string): BranchBankruptcyError {
    return {
      kind: "branch_bankruptcy",
      branch_id: this.branchId,
      agent_name: this.agentName,
      reason,
      attempt_count: this.attemptCount,
      max_bankruptcy_attempts: this.config.max_bankruptcy_attempts,
      repair_rounds: this.repairRoundCount,
      max_repair_rounds: this.config.max_repair_rounds,
      last_error: detail,
      fingerprint_history: [...this.fingerprints],
      reported_at: new Date().toISOString()
    };
  }

  reset(): void {
    this.attempts.length = 0;
    this.fingerprints.length = 0;
    this.stagnantRoundCount = 0;
    this.lastProgressTimestamp = Date.now();
  }

  snapshot(): { attempts: AttemptRecord[]; stagnantRoundCount: number } {
    return {
      attempts: [...this.attempts],
      stagnantRoundCount: this.stagnantRoundCount
    };
  }

  static createFingerprint(output: string): string {
    return AgentCircuitBreaker.normalize(output);
  }

  private static normalize(text: string): string {
    return text
      .replace(/\s+/g, " ")
      .replace(/[`'""]/g, "")
      .replace(/\b(id|uuid|timestamp|created_at|updated_at):\s*['"]?[a-f0-9-]+['"]?/gi, "$1:REDACTED")
      .trim()
      .slice(0, 500);
  }
}
