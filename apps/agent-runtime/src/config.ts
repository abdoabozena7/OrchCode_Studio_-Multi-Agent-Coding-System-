export type RuntimeConfig = {
  host: string;
  port: number;
  storageDir: string;
  defaultMode: "mock" | "real";
  openaiApiKey?: string;
  openaiBaseUrl: string;
};

export function loadConfig(): RuntimeConfig {
  return {
    host: process.env.ORCHCODE_AGENT_HOST ?? "127.0.0.1",
    port: Number(process.env.ORCHCODE_AGENT_PORT ?? "4317"),
    storageDir: process.env.ORCHCODE_AGENT_STORAGE ?? ".orchcode-agent-runtime",
    defaultMode: process.env.ORCHCODE_AGENT_MODE === "real" ? "real" : "mock",
    openaiApiKey: process.env.OPENAI_API_KEY,
    openaiBaseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com"
  };
}
