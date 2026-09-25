import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import type { Prisma } from "../generated/prisma";
import type { CreateCategoryDto, UpdateCategoryDto } from "./dto/category.dto";

@Injectable()
export class CategoriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list() {
    return this.prisma.templateCategory.findMany({ orderBy: { name: "asc" } });
  }

  async get(id: string) {
    const category = await this.prisma.templateCategory.findUnique({ where: { id } });
    if (!category) throw new NotFoundException("Category not found.");
    return category;
  }

  async create(dto: CreateCategoryDto, actorId: string) {
    if (dto.parentId) await this.get(dto.parentId);
    const category = await this.prisma.templateCategory.create({
      data: { name: dto.name, parentId: dto.parentId ?? null, visibility: dto.visibility },
    });
    await this.audit.record({ actorId, action: "category.created", resourceType: "TemplateCategory", resourceId: category.id });
    return category;
  }

  async update(id: string, dto: UpdateCategoryDto, actorId: string) {
    await this.get(id);
    if (dto.parentId === id) throw new BadRequestException("A category cannot be its own parent.");
    if (dto.parentId) await this.get(dto.parentId);
    const category = await this.prisma.$transaction(async (tx) => {
      // Serializes re-parenting, so two concurrent moves can't each pass the check and close a loop together.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('template_categories.tree'))`;
      if (dto.parentId) await this.assertNotDescendant(tx, id, dto.parentId);
      return tx.templateCategory.update({ where: { id }, data: dto });
    });
    await this.audit.record({ actorId, action: "category.updated", resourceType: "TemplateCategory", resourceId: category.id, metadata: dto });
    return category;
  }

  private async assertNotDescendant(tx: Prisma.TransactionClient, id: string, parentId: string) {
    for (let cursor: string | null = parentId; cursor; ) {
      if (cursor === id) throw new BadRequestException("A category cannot be moved into one of its own subcategories.");
      const ancestor: { parentId: string | null } | null = await tx.templateCategory.findUnique({ where: { id: cursor }, select: { parentId: true } });
      cursor = ancestor?.parentId ?? null;
    }
  }

  async remove(id: string, actorId: string) {
    await this.get(id);
    const childCount = await this.prisma.templateCategory.count({ where: { parentId: id } });
    if (childCount > 0) throw new BadRequestException("This category still has subcategories. Move or delete them first.");
    const templateCount = await this.prisma.template.count({ where: { categoryId: id, deletedAt: null } });
    if (templateCount > 0) throw new BadRequestException("This category still has templates. Move them to another category or delete them first.");
    if (await this.prisma.template.count({ where: { categoryId: id } })) {
      throw new BadRequestException("Templates deleted from this category are still used by end users' projects, so it can't be removed.");
    }
    await this.prisma.templateCategory.delete({ where: { id } });
    await this.audit.record({ actorId, action: "category.deleted", resourceType: "TemplateCategory", resourceId: id });
  }
}
