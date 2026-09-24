import { autoFields, type SceneGraph } from "@psd-studio/scene-graph";
import type { Prisma } from "../generated/prisma";
import { CreateFieldSchema } from "./dto/template.dto";

export interface FieldSyncResult {
  created: number;
  removed: number;
}

/**
 * Makes a version's fields match its lock state: every unlocked layer gets a field (with default rules if it has
 * none yet) and locked layers lose theirs. Fields that stay keep whatever label and rules an admin gave them.
 */
export async function syncFieldsWithLocks(tx: Prisma.TransactionClient, versionId: string, sceneGraph: SceneGraph): Promise<FieldSyncResult> {
  const wanted = new Map(autoFields(sceneGraph).map((f) => [f.nodeId, f]));
  const existing = await tx.templateField.findMany({ where: { templateVersionId: versionId }, select: { id: true, nodeId: true } });
  const have = new Set(existing.map((f) => f.nodeId));

  const stale = existing.filter((f) => !wanted.has(f.nodeId)).map((f) => f.id);
  if (stale.length > 0) await tx.templateField.deleteMany({ where: { id: { in: stale } } });

  const missing = [...wanted.values()].filter((f) => !have.has(f.nodeId)).map((f) => ({ templateVersionId: versionId, ...CreateFieldSchema.parse(f) }));
  if (missing.length > 0) await tx.templateField.createMany({ data: missing });

  return { created: missing.length, removed: stale.length };
}
