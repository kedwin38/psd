import { z } from "zod";

/**
 * Every setting the app needs, validated once at boot. Fail fast and loud
 * rather than limping along with an undefined secret (spec §12 secrets
 * management principle applied to config too).
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  API_PORT: z.coerce.number().int().positive().default(3000),
  API_PUBLIC_URL: z.string().default("http://localhost:3000"),
  CORS_ORIGIN: z.string().min(1),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),

  WEBAUTHN_RP_ID: z.string().min(1),
  WEBAUTHN_RP_NAME: z.string().min(1),
  WEBAUTHN_ORIGIN: z.string().min(1),

  JWT_ACCESS_SECRET: z.string().min(32, "JWT_ACCESS_SECRET must be at least 32 characters"),
  JWT_REFRESH_SECRET: z.string().min(32, "JWT_REFRESH_SECRET must be at least 32 characters"),
  JWT_ACCESS_TTL: z.string().default("10m"),
  JWT_REFRESH_TTL: z.string().default("30d"),
  PASSWORD_PEPPER: z.string().min(16),

  STORAGE_DRIVER: z.enum(["local", "s3"]).default("local"),
  STORAGE_LOCAL_PATH: z.string().default("./storage-data"),
  S3_ENDPOINT: z.string().optional().default(""),
  S3_BUCKET: z.string().optional().default(""),
  S3_ACCESS_KEY_ID: z.string().optional().default(""),
  S3_SECRET_ACCESS_KEY: z.string().optional().default(""),
  S3_REGION: z.string().optional().default("auto"),
});

export type Env = z.infer<typeof EnvSchema>;

export function validateEnv(raw: Record<string, unknown>): Env {
  const result = EnvSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return result.data;
}
