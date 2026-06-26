import { PgBoss } from "pg-boss";
import type { FastifyBaseLogger } from "fastify";
import { env } from "../env.js";
import { processBook } from "./processBook.js";

/** The queue that runs ebook parsing + enrichment off the request path. */
export const PROCESS_BOOK_QUEUE = "process-book";

export interface ProcessBookJob {
  bookId: string;
}

let boss: PgBoss | null = null;

/**
 * Start pg-boss against the same Postgres and register the process-book worker.
 * Best-effort: a failure here (e.g. DB not ready in local host dev) is logged,
 * not fatal — the API still serves.
 */
export async function startQueue(logger: FastifyBaseLogger): Promise<void> {
  boss = new PgBoss(env.DATABASE_URL);
  boss.on("error", (err: unknown) => logger.error({ err }, "pg-boss error"));
  await boss.start();
  await boss.createQueue(PROCESS_BOOK_QUEUE);
  await boss.work<ProcessBookJob>(PROCESS_BOOK_QUEUE, async (jobs) => {
    for (const job of jobs) {
      await processBook(job.data.bookId, logger);
    }
  });
  logger.info("pg-boss started");
}

export function getBoss(): PgBoss {
  if (!boss) throw new Error("Queue not started");
  return boss;
}

export async function stopQueue(): Promise<void> {
  await boss?.stop();
  boss = null;
}
