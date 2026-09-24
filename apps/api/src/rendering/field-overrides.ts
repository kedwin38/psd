import { toFieldOverrides, type FieldOverride } from "@psd-studio/scene-graph";
import type { PrismaService } from "../prisma/prisma.service";

/** Loads a project's saved edits as the FieldOverride[] the compositor expects. */
export async function loadFieldOverrides(prisma: PrismaService, projectId: string): Promise<FieldOverride[]> {
  const values = await prisma.projectFieldValue.findMany({
    where: { projectId },
    include: { templateField: true },
  });
  return toFieldOverrides(values.map((v) => ({ nodeId: v.templateField.nodeId, value: v.value })));
}
