import { loadConfig } from "./config.js";
import { buildServer } from "./server.js";

const config = loadConfig();
const { app } = await buildServer(config);

await app.listen({ host: config.host, port: config.port });
console.log(`OrchCode agent runtime listening on http://${config.host}:${config.port} (${config.defaultMode} mode)`);
