import { existsSync } from "node:fs";

export type RuntimeConfig = {
  host: string;
  port: number;
  storageDir: string;
  defaultMode: "demo_mock" | "real_provider";
  openaiApiKey?: string;
  openaiBaseUrl: string;
};

export function loadConfig(): RuntimeConfig {
  return {
    host: process.env.HIVO_AGENT_HOST ?? process.env.ORCHCODE_AGENT_HOST ?? "127.0.0.1",
    port: Number(process.env.HIVO_AGENT_PORT ?? process.env.ORCHCODE_AGENT_PORT ?? "4317"),
    storageDir: process.env.HIVO_AGENT_STORAGE ?? process.env.ORCHCODE_AGENT_STORAGE ?? resolveDefaultStorageDir(),
    defaultMode: isRealProviderMode(process.env.HIVO_AGENT_MODE ?? process.env.ORCHCODE_AGENT_MODE) ? "real_provider" : "demo_mock",
    openaiApiKey: process.env.OPENAI_API_KEY,
    openaiBaseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com"
  };
}

function resolveDefaultStorageDir() {
  if (existsSync(".hivo-agent-runtime")) return ".hivo-agent-runtime";
  if (existsSync(".orchcode-agent-runtime")) return ".orchcode-agent-runtime";
  return ".hivo-agent-runtime";
}

function isRealProviderMode(value: string | undefined) {
  return value === "real_provider" || value === "real";
}
