import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import * as argon2 from "argon2";
import type { Env } from "../config/env";

/**
 * Argon2id with a per-user salt (argon2's default) plus an application-wide
 * pepper held outside the database (spec §12). Passwords are always optional
 * and secondary to WebAuthn — AuthService enforces that admin roles can never
 * authenticate with a password alone, regardless of what this service does.
 */
@Injectable()
export class PasswordService {
  constructor(private readonly config: ConfigService<Env, true>) {}

  async hash(password: string): Promise<string> {
    return argon2.hash(this.withPepper(password), {
      type: argon2.argon2id,
      memoryCost: 19456,
      timeCost: 2,
      parallelism: 1,
    });
  }

  async verify(hash: string, password: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, this.withPepper(password));
    } catch {
      return false;
    }
  }

  private withPepper(password: string): string {
    return `${password}:${this.config.get("PASSWORD_PEPPER")}`;
  }
}
