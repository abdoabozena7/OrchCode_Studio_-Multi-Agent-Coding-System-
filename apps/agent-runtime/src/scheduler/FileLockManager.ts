export class FileLockManager {
  private readonly locks = new Map<string, string>();

  async acquireLocks(
    taskId: string,
    paths: string[],
    options: { timeoutMs?: number; onWait?: (conflict: { path: string; ownerTaskId: string }) => void | Promise<void> } = {}
  ) {
    const timeoutMs = options.timeoutMs ?? 30_000;
    const startedAt = Date.now();
    while (true) {
      const conflict = this.detectConflict(paths);
      if (!conflict) break;
      if (Date.now() - startedAt >= timeoutMs) {
        return { acquired: false, conflict };
      }
      await options.onWait?.(conflict);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    for (const filePath of paths) {
      this.locks.set(filePath, taskId);
    }
    return { acquired: true };
  }

  releaseLocks(taskId: string) {
    for (const [filePath, owner] of this.locks.entries()) {
      if (owner === taskId) this.locks.delete(filePath);
    }
  }

  detectConflict(paths: string[]) {
    for (const filePath of paths) {
      const owner = this.locks.get(filePath);
      if (owner) return { path: filePath, ownerTaskId: owner };
    }
    return undefined;
  }

  snapshot() {
    return Object.fromEntries(this.locks.entries());
  }
}
