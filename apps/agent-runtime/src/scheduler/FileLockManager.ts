export class FileLockManager {
  private readonly locks = new Map<string, string>();

  acquireLocks(taskId: string, paths: string[]) {
    const conflict = this.detectConflict(paths);
    if (conflict) {
      return { acquired: false, conflict };
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
