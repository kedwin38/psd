import { Body, Controller, Get, Param, Post, Query } from "@nestjs/common";
import { ExportsService } from "./exports.service";
import { CreateExportSchema, type CreateExportDto } from "./dto/export.dto";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import type { AuthenticatedUser } from "../auth/auth.types";

@Controller("exports")
export class ExportsController {
  constructor(private readonly exports: ExportsService) {}

  @Post()
  create(@Body(new ZodValidationPipe(CreateExportSchema)) body: CreateExportDto, @CurrentUser() user: AuthenticatedUser) {
    return this.exports.create(body, user.id);
  }

  @Get(":id")
  get(@Param("id") id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.exports.get(id, user.id);
  }

  @Get()
  listForProject(@Query("projectId") projectId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.exports.listForProject(projectId, user.id);
  }
}
