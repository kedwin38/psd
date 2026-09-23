import { Global, Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Queue } from "bullmq";
import type { Env } from "../config/env";
import { INGESTION_QUEUE, RENDER_QUEUE } from "./queue.constants";

export const INGESTION_QUEUE_TOKEN = Symbol("INGESTION_QUEUE");
export const RENDER_QUEUE_TOKEN = Symbol("RENDER_QUEUE");

function connectionFromUrl(url: string) {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: Number(parsed.port || 6379),
    password: parsed.password || undefined,
  };
}

/**
 * Producer-side queue module used by the API to enqueue ingestion/render
 * jobs (spec §5, §13). The workers that actually process these queues run
 * as a separate process (src/worker/main.ts) so they scale independently of
 * the API (spec §15).
 */
@Global()
@Module({
  providers: [
    {
      provide: INGESTION_QUEUE_TOKEN,
      useFactory: (config: ConfigService<Env, true>) =>
        new Queue(INGESTION_QUEUE, { connection: connectionFromUrl(config.get("REDIS_URL")) }),
      inject: [ConfigService],
    },
    {
      provide: RENDER_QUEUE_TOKEN,
      useFactory: (config: ConfigService<Env, true>) =>
        new Queue(RENDER_QUEUE, { connection: connectionFromUrl(config.get("REDIS_URL")) }),
      inject: [ConfigService],
    },
  ],
  exports: [INGESTION_QUEUE_TOKEN, RENDER_QUEUE_TOKEN],
})
export class QueueModule {}
