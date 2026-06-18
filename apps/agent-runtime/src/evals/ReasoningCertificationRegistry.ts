import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ProviderTruthTelemetry, SanitizedProviderConfig } from "@hivo/protocol";
import { ensureMemoryLayout, resolveMemoryPaths, writeJson } from "../memory/ProjectMemory.js";
import type { CertifiedReasoningProfile } from "./adaptiveReasoningCertification.js";

export const REASONING_CERTIFICATION_REGISTRY = "adaptive_reasoning_certifications.json";

export type ReasoningCertificationRecord = CertifiedReasoningProfile & {
  gate: "read_reasoning" | "action_reasoning";
  corpusHash: string;
  reportPath: string;
  certifiedAt: string;
};

type ReasoningCertificationRegistry = {
  version: 2;
  records: ReasoningCertificationRecord[];
};

export async function registerReasoningCertification(workspacePath: string, record: ReasoningCertificationRecord) {
  const memory = await ensureMemoryLayout(workspacePath);
  const validationError = validateRecord(memory.evalsDir, record);
  if (validationError) throw new Error(`adaptive_reasoning_certification_record_invalid: ${validationError}`);
  const registryPath = path.join(memory.rootDir, REASONING_CERTIFICATION_REGISTRY);
  const registry = await readRegistry(registryPath);
  const records = registry.records.filter((entry) =>
    !(entry.providerType === record.providerType
      && entry.authorModel === record.authorModel
      && entry.routerModel === record.routerModel
      && entry.verifierModel === record.verifierModel
      && entry.embeddingModel === record.embeddingModel
      && entry.gate === record.gate
      && entry.corpusHash === record.corpusHash)
  );
  records.push(record);
  await writeJson(registryPath, { version: 2, records } satisfies ReasoningCertificationRegistry);
}

export function resolveModelCertification(
  workspacePath: string,
  config?: SanitizedProviderConfig
): ProviderTruthTelemetry["modelCertification"] {
  const authorModel = config?.selectedModel;
  const routerModel = config?.routerModel ?? authorModel;
  const verifierModel = config?.verifierModel ?? authorModel;
  if (!config || !authorModel) return { status: "uncertified", reason: "No provider model is configured." };
  const registryPath = path.join(resolveMemoryPaths(workspacePath).rootDir, REASONING_CERTIFICATION_REGISTRY);
  if (!existsSync(registryPath)) {
    return { status: "uncertified", routerModel, authorModel, verifierModel, reason: "No passing adaptive-reasoning certification record is loaded." };
  }
  try {
    const registry = JSON.parse(readFileSync(registryPath, "utf8")) as ReasoningCertificationRegistry;
    const records = registry.records.filter((entry) =>
      entry.providerType === config.providerType
      && entry.routerModel === routerModel
      && entry.authorModel === authorModel
      && entry.verifierModel === verifierModel
      && entry.embeddingModel === config.embeddingModel
      && !validateRecord(path.join(path.dirname(registryPath), "evals"), entry)
    );
    const latest = records.sort((left, right) => right.certifiedAt.localeCompare(left.certifiedAt))[0];
    return latest
      ? {
          status: "certified",
          routerModel,
          authorModel,
          verifierModel,
          corpusHash: latest.corpusHash,
          reportPath: latest.reportPath,
          certifiedAt: latest.certifiedAt,
          certifiedGates: [...new Set(records.map((entry) => entry.gate))]
        }
      : { status: "uncertified", routerModel, authorModel, verifierModel, reason: "This exact router/author/verifier/embedding profile has no passing certification record." };
  } catch (error) {
    return { status: "uncertified", routerModel, authorModel, verifierModel, reason: `Certification registry is invalid: ${formatError(error)}` };
  }
}

function validateRecord(evalsDir: string, record: ReasoningCertificationRecord) {
  const reportPath = path.resolve(record.reportPath);
  const safeEvalsRoot = `${path.resolve(evalsDir)}${path.sep}`;
  if (!reportPath.startsWith(safeEvalsRoot)) return "Certification report must be inside the workspace evals directory.";
  if (!existsSync(reportPath)) return "Certification report does not exist.";
  try {
    const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
      certified?: boolean;
      split?: string;
      gate?: string;
      corpusHash?: string;
      modelProfile?: CertifiedReasoningProfile;
      gates?: Record<string, boolean>;
    };
    if (report.certified !== true || report.split !== "holdout") return "Certification report is not a passing holdout report.";
    if (report.gate !== record.gate) return "Certification report gate does not match.";
    if (report.corpusHash !== record.corpusHash) return "Certification report corpus hash does not match.";
    if (report.modelProfile?.providerType !== record.providerType
      || report.modelProfile.routerModel !== record.routerModel
      || report.modelProfile.authorModel !== record.authorModel
      || report.modelProfile.verifierModel !== record.verifierModel
      || report.modelProfile.embeddingModel !== record.embeddingModel
      || !capabilitiesMatch(report.modelProfile.capabilities, record.capabilities)) {
      return "Certification report reasoning profile does not match.";
    }
    if (!report.gates || !Object.values(report.gates).length || !Object.values(report.gates).every(Boolean)) {
      return "Certification report gates did not all pass.";
    }
    return undefined;
  } catch (error) {
    return `Certification report is invalid: ${formatError(error)}`;
  }
}

async function readRegistry(registryPath: string): Promise<ReasoningCertificationRegistry> {
  try {
    const parsed = JSON.parse(await readFile(registryPath, "utf8")) as ReasoningCertificationRegistry;
    if (parsed.version !== 2) return { version: 2, records: [] };
    return { version: 2, records: Array.isArray(parsed.records) ? parsed.records : [] };
  } catch {
    return { version: 2, records: [] };
  }
}

function capabilitiesMatch(
  left: CertifiedReasoningProfile["capabilities"] | undefined,
  right: CertifiedReasoningProfile["capabilities"]
) {
  return Boolean(left)
    && left!.readReasoning === right.readReasoning
    && left!.actionReasoning === right.actionReasoning
    && left!.readonlySwarm === right.readonlySwarm
    && left!.embeddings === right.embeddings;
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
