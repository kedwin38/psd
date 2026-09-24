import { BadRequestException, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
  type WebAuthnCredential,
} from "@simplewebauthn/server";
import type { Redis } from "ioredis";
import type { Env } from "../config/env";
import { REDIS_CLIENT } from "../redis/redis.module";
import { PrismaService } from "../prisma/prisma.service";

const CHALLENGE_TTL_SECONDS = 300;

type ChallengePurpose = "registration" | "authentication" | "step-up";

@Injectable()
export class WebAuthnService {
  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  private challengeKey(userId: string, purpose: ChallengePurpose): string {
    return `webauthn:challenge:${purpose}:${userId}`;
  }

  private async saveChallenge(userId: string, purpose: ChallengePurpose, challenge: string): Promise<void> {
    await this.redis.set(this.challengeKey(userId, purpose), challenge, "EX", CHALLENGE_TTL_SECONDS);
  }

  private async takeChallenge(userId: string, purpose: ChallengePurpose): Promise<string> {
    const key = this.challengeKey(userId, purpose);
    const challenge = await this.redis.get(key);
    if (!challenge) {
      throw new UnauthorizedException("No pending WebAuthn challenge (it may have expired); request new options first.");
    }
    await this.redis.del(key);
    return challenge;
  }

  async generateRegistrationOptionsFor(userId: string, email: string, displayName: string): Promise<PublicKeyCredentialCreationOptionsJSON> {
    const existing = await this.prisma.webAuthnCredential.findMany({ where: { userId } });
    const options = await generateRegistrationOptions({
      rpName: this.config.get("WEBAUTHN_RP_NAME"),
      rpID: this.config.get("WEBAUTHN_RP_ID"),
      userName: email,
      userDisplayName: displayName,
      attestationType: "none",
      excludeCredentials: existing.map((c) => ({ id: c.credentialId, transports: c.transports as any })),
      authenticatorSelection: {
        residentKey: "preferred",
        userVerification: "preferred",
      },
    });
    await this.saveChallenge(userId, "registration", options.challenge);
    return options;
  }

  async verifyRegistration(userId: string, response: RegistrationResponseJSON, deviceLabel?: string): Promise<void> {
    const expectedChallenge = await this.takeChallenge(userId, "registration");
    const verification = await verifyRegistrationResponse({
      response,
      expectedChallenge,
      expectedOrigin: this.config.get("WEBAUTHN_ORIGIN"),
      expectedRPID: this.config.get("WEBAUTHN_RP_ID"),
    });
    if (!verification.verified || !verification.registrationInfo) {
      throw new UnauthorizedException("WebAuthn registration could not be verified.");
    }
    const { credential } = verification.registrationInfo;
    await this.prisma.webAuthnCredential.create({
      data: {
        userId,
        credentialId: credential.id,
        publicKey: Buffer.from(credential.publicKey),
        counter: BigInt(credential.counter),
        transports: credential.transports ?? [],
        deviceLabel,
      },
    });
    await this.prisma.user.update({ where: { id: userId }, data: { mfaEnrolled: true } });
  }

  async generateAuthenticationOptionsFor(userId: string, purpose: ChallengePurpose = "authentication"): Promise<PublicKeyCredentialRequestOptionsJSON> {
    const credentials = await this.prisma.webAuthnCredential.findMany({ where: { userId } });
    if (credentials.length === 0) {
      throw new BadRequestException("No passkeys registered for this account.");
    }
    const options = await generateAuthenticationOptions({
      rpID: this.config.get("WEBAUTHN_RP_ID"),
      userVerification: "preferred",
      allowCredentials: credentials.map((c) => ({ id: c.credentialId, transports: c.transports as any })),
    });
    await this.saveChallenge(userId, purpose, options.challenge);
    return options;
  }

  async verifyAuthentication(userId: string, response: AuthenticationResponseJSON, purpose: ChallengePurpose = "authentication"): Promise<void> {
    const expectedChallenge = await this.takeChallenge(userId, purpose);
    const stored = await this.prisma.webAuthnCredential.findUnique({ where: { credentialId: response.id } });
    if (!stored || stored.userId !== userId) {
      throw new UnauthorizedException("Unknown credential.");
    }
    const credential: WebAuthnCredential = {
      id: stored.credentialId,
      publicKey: new Uint8Array(stored.publicKey),
      counter: Number(stored.counter),
      transports: stored.transports as any,
    };
    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: this.config.get("WEBAUTHN_ORIGIN"),
      expectedRPID: this.config.get("WEBAUTHN_RP_ID"),
      credential,
    });
    if (!verification.verified) {
      throw new UnauthorizedException("WebAuthn authentication could not be verified.");
    }
    await this.prisma.webAuthnCredential.update({
      where: { id: stored.id },
      data: { counter: BigInt(verification.authenticationInfo.newCounter), lastUsedAt: new Date() },
    });
  }
}
