import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  createPreApplySnapshot,
  createRollbackResult,
  type PreApplySnapshot,
  type RollbackResult
} from "./ControlledIntegrationApplyModels.js";

export class ControlledRollbackManager {
  constructor(private readonly workspacePath: string) {}

  async createSnapshot(input: {
    controlled_apply_id: string;
    run_id: string;
    integration_candidate_id: string;
    changed_files: string[];
    snapshotDir: string;
  }): Promise<PreApplySnapshot> {
    const contentDir = path.join(input.snapshotDir, "contents");
    await mkdir(contentDir, { recursive: true });
    const files = [];
    for (const file of uniqueStrings(input.changed_files.map(normalizeRelativePath))) {
      const resolved = path.resolve(this.workspacePath, file);
      if (!isInside(this.workspacePath, resolved) || !existsSync(resolved)) {
        files.push({ path: file, exists: false });
        continue;
      }
      const content = await readFile(resolved);
      const contentRef = path.join(contentDir, `${safeId(file)}.snapshot`);
      await mkdir(path.dirname(contentRef), { recursive: true });
      await writeFile(contentRef, content);
      files.push({
        path: file,
        exists: true,
        sha256: createHash("sha256").update(content).digest("hex"),
        size: content.byteLength,
        content_ref: contentRef
      });
    }
    return createPreApplySnapshot({
      controlled_apply_id: input.controlled_apply_id,
      run_id: input.run_id,
      integration_candidate_id: input.integration_candidate_id,
      changed_files: uniqueStrings(input.changed_files.map(normalizeRelativePath)),
      files,
      content_dir_ref: contentDir,
      metadata_json: { content_externalized: true }
    });
  }

  async rollback(input: {
    controlled_apply_id: string;
    run_id: string;
    integration_candidate_id: string;
    snapshot: PreApplySnapshot;
  }): Promise<RollbackResult> {
    const restored: string[] = [];
    const failed: string[] = [];
    for (const file of input.snapshot.files) {
      const target = path.resolve(this.workspacePath, normalizeRelativePath(file.path));
      if (!isInside(this.workspacePath, target)) {
        failed.push(file.path);
        continue;
      }
      try {
        if (!file.exists) {
          await rm(target, { force: true, recursive: false });
          restored.push(file.path);
          continue;
        }
        if (!file.content_ref || !existsSync(file.content_ref)) {
          failed.push(file.path);
          continue;
        }
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, await readFile(file.content_ref));
        restored.push(file.path);
      } catch {
        failed.push(file.path);
      }
    }
    return createRollbackResult({
      controlled_apply_id: input.controlled_apply_id,
      run_id: input.run_id,
      integration_candidate_id: input.integration_candidate_id,
      status: failed.length ? "rollback_failed" : "rolled_back",
      restored_files: restored,
      failed_files: failed
    });
  }
}

function normalizeRelativePath(value: string) {
  return value.replace(/\\/g, "/").replace(/^\.\/+/, "");
}

function isInside(root: string, target: string) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function safeId(value: string) {
  return value.replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 140) || "file";
}
