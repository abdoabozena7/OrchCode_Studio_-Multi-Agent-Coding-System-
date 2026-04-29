import { execFileSync } from "node:child_process";

export class GitTools {
  constructor(private readonly workspacePath: string) {}

  status() {
    return this.git(["status", "--short"]);
  }

  diff() {
    return this.git(["diff", "--", "."]);
  }

  private git(args: string[]) {
    try {
      return execFileSync("git", args, {
        cwd: this.workspacePath,
        encoding: "utf8",
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }
}
