import { loadConfig } from "./config.js";
import { memoryCache } from "./memory/MemoryCache.js";
import { buildServer } from "./server.js";

const config = loadConfig();
await memoryCache.deletePrefix("hivo:verified-answer:v1:");
const { app } = await buildServer(config);

await app.listen({ host: config.host, port: config.port });
console.log(`Hivo agent runtime listening on http://${config.host}:${config.port} (${config.defaultMode} mode)`);
