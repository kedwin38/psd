import { Body, Controller, Delete, Get, Param, Patch, Post } from "@nestjs/common";
import { CategoriesService } from "./categories.service";
import { CreateCategorySchema, UpdateCategorySchema, type CreateCategoryDto, type UpdateCategoryDto } from "./dto/category.dto";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { Roles } from "../auth/decorators/roles.decorator";
import { StepUp } from "../auth/decorators/step-up.decorator";
import { Public } from "../auth/decorators/public.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { RoleName } from "../generated/prisma";
import type { AuthenticatedUser } from "../auth/auth.types";

@Controller("categories")
export class CategoriesController {
  constructor(private readonly categories: CategoriesService) {}

  @Public()
  @Get()
  list() {
    return this.categories.list();
  }

  @Public()
  @Get(":id")
  get(@Param("id") id: string) {
    return this.categories.get(id);
  }

  @Roles(RoleName.SUPER_ADMIN, RoleName.CONTENT_ADMIN)
  @Post()
  create(@Body(new ZodValidationPipe(CreateCategorySchema)) body: CreateCategoryDto, @CurrentUser() user: AuthenticatedUser) {
    return this.categories.create(body, user.id);
  }

  @Roles(RoleName.SUPER_ADMIN, RoleName.CONTENT_ADMIN)
  @Patch(":id")
  update(@Param("id") id: string, @Body(new ZodValidationPipe(UpdateCategorySchema)) body: UpdateCategoryDto, @CurrentUser() user: AuthenticatedUser) {
    return this.categories.update(id, body, user.id);
  }

  @Roles(RoleName.SUPER_ADMIN, RoleName.CONTENT_ADMIN)
  @StepUp()
  @Delete(":id")
  async remove(@Param("id") id: string, @CurrentUser() user: AuthenticatedUser) {
    await this.categories.remove(id, user.id);
    return { ok: true };
  }
}
