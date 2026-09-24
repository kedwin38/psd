import { Controller, Get, Inject, NotFoundException, Query, Res } from "@nestjs/common";
import type { Response } from "express";
import { Public } from "../auth/decorators/public.decorator";
import { PrismaService } from "../prisma/prisma.service";
import { LocalDiskStorageDriver } from "./local-disk.driver";
import { STORAGE_DRIVER, type StorageDriver } from "./storage.types";

/**
 * Only meaningful for the local-disk driver: with S3/R2 in production, the
 * signed URL points directly at the object store and this route is unused.
 * The signature/expiry check (spec §12) is real either way.
 */
@Controller("assets")
export class AssetsController {
  constructor(
    @Inject(STORAGE_DRIVER) private readonly driver: StorageDriver,
    private readonly prisma: PrismaService,
  ) {}

  @Public()
  @Get("download")
  async download(
    @Query("key") key: string,
    @Query("exp") exp: string,
    @Query("sig") sig: string,
    @Query("filename") filename: string | undefined,
    @Res() res: Response,
  ) {
    if (!(this.driver instanceof LocalDiskStorageDriver)) {
      throw new NotFoundException();
    }
    this.driver.verifySignature(key, Number(exp), sig);
    const [bytes, asset] = await Promise.all([this.driver.get(key), this.prisma.asset.findUnique({ where: { storageKey: key }, select: { mimeType: true } })]);
    res.setHeader("Content-Type", asset?.mimeType ?? "application/octet-stream");
    if (filename) res.setHeader("Content-Disposition", `attachment; filename="${filename.replace(/"/g, "")}"`);
    res.setHeader("Cache-Control", "private, max-age=60");
    res.send(bytes);
  }
}
