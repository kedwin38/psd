import { Injectable, Logger } from "@nestjs/common";
import { createHash } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";

export interface AuditEntryInput {
  actorId?: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, unknown> | null;
}

const GENESIS_HASH = "0".repeat(64);
// Arbitrary fixed key for a Postgres session-level advisory lock scoping the audit
// hash chain — serializes concurrent writers so "read latest hash, then insert" is
// race-free without needing SELECT ... FOR UPDATE against a row that doesn't exist yet.
const AUDIT_CHAIN_LOCK_KEY = 727164n;

/**
 * Append-only, hash-chained audit log (spec §12, §17). Each entry embeds the
 * hash of the entry before it, so any row tampered with after the fact breaks
 * every hash after it — detectable by re-walking the chain (verifyChain()).
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(input: AuditEntryInput): Promise<void> {
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${AUDIT_CHAIN_LOCK_KEY})`;
        const last = await tx.auditLogEntry.findFirst({ orderBy: { createdAt: "desc" } });
        const prevHash = last?.hash ?? GENESIS_HASH;
        const createdAt = new Date();
        const payload = JSON.stringify({
          prevHash,
          actorId: input.actorId ?? null,
          action: input.action,
          resourceType: input.resourceType,
          resourceId: input.resourceId ?? null,
          ip: input.ip ?? null,
          userAgent: input.userAgent ?? null,
          metadata: input.metadata ?? null,
          createdAt: createdAt.toISOString(),
        });
        const hash = createHash("sha256").update(payload).digest("hex");
        await tx.auditLogEntry.create({
          data: {
            actorId: input.actorId ?? undefined,
            action: input.action,
            resourceType: input.resourceType,
            resourceId: input.resourceId ?? undefined,
            ip: input.ip ?? undefined,
            userAgent: input.userAgent ?? undefined,
            metadata: (input.metadata ?? undefined) as never,
            prevHash,
            hash,
            createdAt,
          },
        });
      });
    } catch (error) {
      // Never let an audit-log failure take down the request it's describing —
      // but it must be loud, since a silently-broken audit trail is a security gap.
      this.logger.error(`Failed to write audit log entry for action=${input.action}`, error as Error);
    }
  }

  /** Re-walks the chain and confirms every entry's hash matches its recomputed value. */
  async verifyChain(): Promise<{ valid: boolean; brokenAtId?: string }> {
    const entries = await this.prisma.auditLogEntry.findMany({ orderBy: { createdAt: "asc" } });
    let expectedPrev = GENESIS_HASH;
    for (const entry of entries) {
      const payload = JSON.stringify({
        prevHash: entry.prevHash,
        actorId: entry.actorId,
        action: entry.action,
        resourceType: entry.resourceType,
        resourceId: entry.resourceId,
        ip: entry.ip,
        userAgent: entry.userAgent,
        metadata: entry.metadata,
        createdAt: entry.createdAt.toISOString(),
      });
      const recomputed = createHash("sha256").update(payload).digest("hex");
      if (entry.prevHash !== expectedPrev || recomputed !== entry.hash) {
        return { valid: false, brokenAtId: entry.id };
      }
      expectedPrev = entry.hash;
    }
    return { valid: true };
  }
}
