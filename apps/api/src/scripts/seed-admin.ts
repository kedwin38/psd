// One-time bootstrap script for provisioning a default SUPER_ADMIN account
// in an environment with no interactive database access. Run via
// `node dist/scripts/seed-admin.js` (wired temporarily into the deploy's
// preDeployCommand) — reads DATABASE_URL/PASSWORD_PEPPER from the process
// environment the same way the app itself does, so no secret is ever read
// outside the container. Prints the generated credentials to stdout once;
// safe to re-run (upserts the same account).
import "reflect-metadata";
import * as argon2 from "argon2";
import { createCipheriv, randomBytes, scryptSync } from "node:crypto";
import { Secret, TOTP } from "otpauth";
import { PrismaClient, RoleName, UserStatus } from "../generated/prisma";

const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? "admin@psdtemplatestudio.com";
const ADMIN_DISPLAY_NAME = process.env.ADMIN_DISPLAY_NAME ?? "Studio Admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? randomBytes(12).toString("base64url");

function encryptionKey(pepper: string): Buffer {
  return scryptSync(pepper, "totp-secret-encryption", 32);
}

function encrypt(plaintext: string, pepper: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(pepper), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString("base64"), authTag.toString("base64"), ciphertext.toString("base64")].join(".");
}

async function main() {
  const pepper = process.env.PASSWORD_PEPPER;
  if (!pepper) throw new Error("PASSWORD_PEPPER is not set in this environment.");

  const prisma = new PrismaClient();
  try {
    const passwordHash = await argon2.hash(`${ADMIN_PASSWORD}:${pepper}`, {
      type: argon2.argon2id,
      memoryCost: 19456,
      timeCost: 2,
      parallelism: 1,
    });

    const secret = new Secret({ size: 20 });
    const totp = new TOTP({ issuer: "PSD Template Studio", label: ADMIN_EMAIL, secret });
    const secretCipher = encrypt(secret.base32, pepper);

    const user = await prisma.user.upsert({
      where: { email: ADMIN_EMAIL },
      create: {
        email: ADMIN_EMAIL,
        displayName: ADMIN_DISPLAY_NAME,
        status: UserStatus.ACTIVE,
        passwordHash,
        mfaEnrolled: true,
      },
      update: {
        passwordHash,
        mfaEnrolled: true,
        status: UserStatus.ACTIVE,
      },
    });

    await prisma.totpCredential.upsert({
      where: { userId: user.id },
      create: { userId: user.id, secretCipher, recoveryCodesHash: [], verifiedAt: new Date() },
      update: { secretCipher, verifiedAt: new Date() },
    });

    const hasSuperAdmin = await prisma.userRoleAssignment.findFirst({
      where: { userId: user.id, role: RoleName.SUPER_ADMIN, organizationId: null, categoryId: null },
    });
    if (!hasSuperAdmin) {
      await prisma.userRoleAssignment.create({
        data: { userId: user.id, role: RoleName.SUPER_ADMIN },
      });
    }

    console.log(
      "SEED_ADMIN_RESULT " +
        JSON.stringify({
          userId: user.id,
          email: ADMIN_EMAIL,
          password: ADMIN_PASSWORD,
          totpSecretBase32: secret.base32,
          otpauthUrl: totp.toString(),
        }),
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error("seed-admin failed:", err);
  process.exit(1);
});
