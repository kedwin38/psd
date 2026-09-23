import { Global, Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Redis from "ioredis";
import type { Env } from "../config/env";

export const REDIS_CLIENT = Symbol("REDIS_CLIENT");

@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      useFactory: (config: ConfigService<Env, true>) => new Redis(config.get("REDIS_URL"), { maxRetriesPerRequest: null }),
      inject: [ConfigService],
    },
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule {}
