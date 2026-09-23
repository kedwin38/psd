import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
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
    const category = await this.prisma.templateCategory.update({ where: { id }, data: dto });
    await this.audit.record({ actorId, action: "category.updated", resourceType: "TemplateCategory", resourceId: category.id, metadata: dto });
    return category;
  }

  async remove(id: string, actorId: string) {
    await this.get(id);
    const childCount = await this.prisma.templateCategory.count({ where: { parentId: id } });
    if (childCount > 0) throw new BadRequestException("Cannot delete a category that still has subcategories.");
    const templateCount = await this.prisma.template.count({ where: { categoryId: id } });
    if (templateCount > 0) throw new BadRequestException("Cannot delete a category that still has templates.");
    await this.prisma.templateCategory.delete({ where: { id } });
    await this.audit.record({ actorId, action: "category.deleted", resourceType: "TemplateCategory", resourceId: id });
  }
}
