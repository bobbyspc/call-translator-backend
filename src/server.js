import "dotenv/config";
import { loadConfig } from "./config.js";
import { createServer } from "./app.js";
import { createFileStore } from "./store.js";
import { createProviders } from "./providers.js";

const config = loadConfig();
const logger = console;
const app = await createServer({
  config,
  store: createFileStore(config.dataFile),
  providers: createProviders(config, logger),
});
let keepWarm;
if (config.keepWarmUrl) {
  keepWarm = setInterval(
    () => fetch(config.keepWarmUrl).catch(() => {}),
    config.keepWarmMinutes * 60 * 1000,
  );
  keepWarm.unref?.();
}
try {
  await app.listen({ port: config.port, host: config.host });
} catch (error) {
  console.error(error);
  process.exit(1);
}
