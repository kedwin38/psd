import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from "node:crypto";
import { BadRequestException, Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Secret, TOTP } from "otpauth";
import type { Env } from "../config/env";
import { PrismaService } from "../prisma/prisma.service";

const RECOVERY_CODE_COUNT = 8;

/**
 * TOTP fallback for devices without a platform authenticator (spec §12).
 * The shared secret is envelope-encrypted at rest with AES-256-GCM; in
 * production the encryption key itself should live in a real KMS rather
 * than be derived from an app secret as it is here for local development.
 */
@Injectable()
export class TotpService {
  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly prisma: PrismaService,
  ) {}

  private encryptionKey(): Buffer {
    return scryptSync(this.config.get("PASSWORD_PEPPER"), "totp-secret-encryption", 32);
  }

  private encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.encryptionKey(), iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return [iv.toString("base64"), authTag.toString("base64"), ciphertext.toString("base64")].join(".");
  }

  private decrypt(stored: string): string {
    const [ivB64, tagB64, dataB64] = stored.split(".");
    if (!ivB64 || !tagB64 || !dataB64) throw new Error("Malformed encrypted TOTP secret.");
    const decipher = createDecipheriv("aes-256-gcm", this.encryptionKey(), Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]).toString("utf8");
  }

  private hashRecoveryCode(code: string): string {
    return createHash("sha256").update(code).digest("hex");
  }

  async beginEnrollment(userId: string, email: string): Promise<{ otpauthUrl: string; secretBase32: string }> {
    const secret = new Secret({ size: 20 });
    const totp = new TOTP({
      issuer: "PSD Template Studio",
      label: email,
      secret,
    });
    await this.prisma.totpCredential.upsert({
      where: { userId },
      create: { userId, secretCipher: this.encrypt(secret.base32), recoveryCodesHash: [] },
      update: { secretCipher: this.encrypt(secret.base32), verifiedAt: null, recoveryCodesHash: [] },
    });
    return { otpauthUrl: totp.toString(), secretBase32: secret.base32 };
  }

  async confirmEnrollment(userId: string, code: string): Promise<{ recoveryCodes: string[] }> {
    const stored = await this.prisma.totpCredential.findUnique({ where: { userId } });
    if (!stored) throw new BadRequestException("Start TOTP enrollment first.");
    const totp = new TOTP({ secret: Secret.fromBase32(this.decrypt(stored.secretCipher)) });
    const delta = totp.validate({ token: code, window: 1 });
    if (delta === null) throw new UnauthorizedException("Invalid TOTP code.");

    const recoveryCodes = Array.from({ length: RECOVERY_CODE_COUNT }, () => randomBytes(5).toString("hex"));
    await this.prisma.totpCredential.update({
      where: { userId },
      data: {
        verifiedAt: new Date(),
        recoveryCodesHash: recoveryCodes.map((c) => this.hashRecoveryCode(c)),
      },
    });
    await this.prisma.user.update({ where: { id: userId }, data: { mfaEnrolled: true, mfaSetupRequired: false, mfaSetupDeadline: null } });
    return { recoveryCodes };
  }

  async verifyCode(userId: string, code: string): Promise<boolean> {
    const stored = await this.prisma.totpCredential.findUnique({ where: { userId } });
    if (!stored || !stored.verifiedAt) return false;

    const totp = new TOTP({ secret: Secret.fromBase32(this.decrypt(stored.secretCipher)) });
    if (totp.validate({ token: code, window: 1 }) !== null) return true;

    // Fall back to single-use recovery codes.
    const hash = this.hashRecoveryCode(code);
    if (stored.recoveryCodesHash.includes(hash)) {
      await this.prisma.totpCredential.update({
        where: { userId },
        data: { recoveryCodesHash: stored.recoveryCodesHash.filter((h) => h !== hash) },
      });
      return true;
    }
    return false;
  }

  async isEnrolled(userId: string): Promise<boolean> {
    const stored = await this.prisma.totpCredential.findUnique({ where: { userId } });
    return !!stored?.verifiedAt;
  }
}
