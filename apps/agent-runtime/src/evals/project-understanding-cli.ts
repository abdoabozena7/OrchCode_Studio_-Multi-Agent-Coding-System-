import path from "node:path";
import { OllamaProvider } from "../llm/OllamaProvider.js";
import { OpenAIProvider } from "../llm/OpenAIProvider.js";
import { runProjectUnderstandingBenchmark } from "./projectUnderstanding.js";

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log([
    "Usage: npm run eval:project-understanding -- --corpus <path> --embedding-model <model> [--output-workspace <path>]",
    "",
    "Requires OPENAI_API_KEY + OPENAI_MODEL or OLLAMA_MODEL.",
    "The corpus must contain at least 120 human-reviewed cases across five repositories, with at least 25% Arabic cases."
  ].join("\n"));
  process.exit(0);
}
const embeddingModel = args.embeddingModel ?? process.env.HIVO_EMBEDDING_MODEL ?? process.env.OPENAI_EMBEDDING_MODEL ?? process.env.OLLAMA_EMBEDDING_MODEL;
if (!embeddingModel) throw new Error("Set --embedding-model or HIVO_EMBEDDING_MODEL before running the deep project-understanding benchmark.");
const providerFactory = createProviderFactory(embeddingModel);
const summary = await runProjectUnderstandingBenchmark({
  corpusPath: args.corpus,
  outputWorkspace: args.outputWorkspace,
  embeddingModel,
  providerFactory
});
console.log(JSON.stringify(summary, null, 2));
if (!Object.values(summary.gates).every(Boolean)) process.exitCode = 1;

function createProviderFactory(embeddingModel: string) {
  if (process.env.OPENAI_API_KEY && process.env.OPENAI_MODEL) {
    return () => new OpenAIProvider(
      process.env.OPENAI_API_KEY,
      process.env.OPENAI_BASE_URL ?? "https://api.openai.com",
      process.env.OPENAI_MODEL!,
      90_000,
      embeddingModel
    );
  }
  if (process.env.OLLAMA_MODEL) {
    return () => new OllamaProvider(
      process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434",
      process.env.OLLAMA_MODEL!,
      90_000,
      embeddingModel
    );
  }
  throw new Error("Configure OPENAI_API_KEY + OPENAI_MODEL or OLLAMA_MODEL before running the benchmark.");
}

function parseArgs(args: string[]) {
  const options: { corpus: string; outputWorkspace?: string; embeddingModel?: string; help?: boolean } = {
    corpus: process.env.HIVO_PROJECT_UNDERSTANDING_CORPUS ?? "project-understanding-corpus.json"
  };
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--corpus") options.corpus = args[++index] ?? options.corpus;
    else if (args[index] === "--output-workspace") options.outputWorkspace = args[++index];
    else if (args[index] === "--embedding-model") options.embeddingModel = args[++index];
    else if (args[index] === "--help" || args[index] === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${args[index]}`);
  }
  options.corpus = path.resolve(options.corpus);
  return options;
}
