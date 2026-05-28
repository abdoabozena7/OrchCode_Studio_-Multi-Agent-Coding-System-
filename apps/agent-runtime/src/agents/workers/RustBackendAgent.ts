import type { TaskNode } from "@hivo/protocol";
import { BaseWorker, type WorkerContext } from "./BaseWorker.js";

export class RustBackendAgent extends BaseWorker {
  readonly agentName = "RustBackendAgent";

  protected execute(task: TaskNode, context: WorkerContext) {
    const target = task.fileLocks[0] ?? "apps/desktop/src-tauri/src/lib.rs";
    return {
      summary: "Assessed Rust/Tauri backend impact.",
      details: [`Potential backend touchpoint: ${target}`, "No backend patch required in mock orchestration unless requested."],
      risks: ["Backend changes require Rust cargo checks and command policy review."]
    };
  }
}
