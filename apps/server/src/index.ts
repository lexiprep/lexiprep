import { buildApp } from "./app.js";
import { env } from "./env.js";
import { startQueue, stopQueue } from "./queue/boss.js";

const app = await buildApp();

await startQueue(app.log).catch((err) => {
  app.log.warn({ err }, "queue not started (continuing without background jobs)");
});

const close = async (signal: string): Promise<void> => {
  app.log.info({ signal }, "shutting down");
  await app.close();
  await stopQueue();
  process.exit(0);
};
process.on("SIGINT", () => void close("SIGINT"));
process.on("SIGTERM", () => void close("SIGTERM"));

await app.listen({ host: "0.0.0.0", port: env.PORT });
