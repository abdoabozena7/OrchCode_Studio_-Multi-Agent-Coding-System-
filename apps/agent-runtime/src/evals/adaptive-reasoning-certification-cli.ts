import path from "node:path";
import { OllamaProvider } from "../llm/OllamaProvider.js";
import { OpenAIProvider } from "../llm/OpenAIProvider.js";
import { runAdaptiveReasoningCertification, type CertifiedReasoningProfile, validateAdaptiveReasoningCorpusFile } from "./adaptiveReasoningCertification.js";

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log([
    "Usage: npm run eval:adaptive-reasoning -- --corpus <path> [--output-workspace <path>]",
    "       npm run eval:adaptive-reasoning -- --corpus <path> --validate-only",
    "",
    "OpenAI-compatible: set OPENAI_API_KEY and OPENAI_AUTHOR_MODEL or OPENAI_MODEL.",
    "Ollama: set OLLAMA_AUTHOR_MODEL or OLLAMA_MODEL.",
    "Optional router/verifier models: OPENAI_ROUTER_MODEL / OPENAI_VERIFIER_MODEL or OLLAMA_ROUTER_MODEL / OLLAMA_VERIFIER_MODEL.",
    "Read certification requires a sealed 240-case holdout across 8 pinned repositories.",
    "Action certification requires a sealed 120-case holdout across 8 pinned repositories."
  ].join("\n"));
  process.exit(0);
}

if (args.validateOnly) {
  const validation = await validateAdaptiveReasoningCorpusFile(args.corpus);
  console.log(JSON.stringify({
    valid: true,
    version: validation.corpus.version,
    gate: validation.corpus.gate,
    split: validation.corpus.split,
    sealed: validation.corpus.sealed,
    repositories: validation.corpus.repositories.length,
    cases: validation.caseCount,
    corpusHash: validation.corpusHash
  }, null, 2));
} else {
  const configured = providerConfiguration();
  const summary = await runAdaptiveReasoningCertification({
    corpusPath: args.corpus,
    outputWorkspace: args.outputWorkspace,
    modelProfile: configured.modelProfile,
    providerFactory: (_repositoryId, role) => configured.create(role),
    runs: args.runs
  });
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.certified) process.exitCode = 1;
}

function providerConfiguration(): {
  modelProfile: CertifiedReasoningProfile;
  create: (role: "router" | "author" | "verifier") => OllamaProvider | OpenAIProvider;
} {
  const openAiAuthor = process.env.OPENAI_AUTHOR_MODEL ?? process.env.OPENAI_MODEL;
  if (process.env.OPENAI_API_KEY && openAiAuthor) {
    const verifier = process.env.OPENAI_VERIFIER_MODEL ?? openAiAuthor;
    const router = process.env.OPENAI_ROUTER_MODEL ?? openAiAuthor;
    const baseUrl = process.env.OPENAI_BASE_URL ?? "https://api.openai.com";
    return {
      modelProfile: createProfile("openai_compatible", router, openAiAuthor, verifier, process.env.OPENAI_EMBEDDING_MODEL),
      create: (role) => new OpenAIProvider(process.env.OPENAI_API_KEY, baseUrl, role === "router" ? router : role === "author" ? openAiAuthor : verifier, 180_000, process.env.OPENAI_EMBEDDING_MODEL)
    };
  }
  const ollamaAuthor = process.env.OLLAMA_AUTHOR_MODEL ?? process.env.OLLAMA_MODEL;
  if (ollamaAuthor) {
    const verifier = process.env.OLLAMA_VERIFIER_MODEL ?? ollamaAuthor;
    const router = process.env.OLLAMA_ROUTER_MODEL ?? ollamaAuthor;
    const baseUrl = process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434";
    return {
      modelProfile: createProfile("ollama", router, ollamaAuthor, verifier, process.env.OLLAMA_EMBEDDING_MODEL),
      create: (role) => new OllamaProvider(baseUrl, role === "router" ? router : role === "author" ? ollamaAuthor : verifier, 180_000, process.env.OLLAMA_EMBEDDING_MODEL)
    };
  }
  throw new Error("Configure an OpenAI-compatible or Ollama author model before running adaptive-reasoning certification.");
}

function createProfile(
  providerType: CertifiedReasoningProfile["providerType"],
  routerModel: string,
  authorModel: string,
  verifierModel: string,
  embeddingModel?: string
): CertifiedReasoningProfile {
  return {
    providerType,
    routerModel,
    authorModel,
    verifierModel,
    embeddingModel,
    capabilities: {
      readReasoning: false,
      actionReasoning: false,
      readonlySwarm: true,
      embeddings: Boolean(embeddingModel)
    }
  };
}

function parseArgs(args: string[]) {
  const options: { corpus: string; outputWorkspace?: string; help?: boolean; validateOnly?: boolean; runs?: number } = {
    corpus: process.env.HIVO_ADAPTIVE_REASONING_CORPUS ?? "adaptive-reasoning-corpus.json"
  };
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--corpus") options.corpus = args[++index] ?? options.corpus;
    else if (args[index] === "--output-workspace") options.outputWorkspace = args[++index];
    else if (args[index] === "--validate-only") options.validateOnly = true;
    else if (args[index] === "--runs") options.runs = Number(args[++index]);
    else if (args[index] === "--help" || args[index] === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${args[index]}`);
  }
  options.corpus = path.resolve(options.corpus);
  if (options.outputWorkspace) options.outputWorkspace = path.resolve(options.outputWorkspace);
  if (options.runs !== undefined && (!Number.isInteger(options.runs) || options.runs < 3)) {
    throw new Error("--runs must be an integer of at least 3.");
  }
  return options;
}
