import { Controller, Get, Res } from "@nestjs/common";
import type { Response } from "express";
import { SettingsService } from "./settings.service";

/**
 * Read side only, reachable by any signed-in account (admins previewing their own upload and end users editing
 * templates alike) — never role-gated, unlike the admin/settings mutating routes.
 */
@Controller("settings")
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get("watermark")
  getWatermark() {
    return this.settings.getPublic();
  }

  @Get("watermark/image")
  async getWatermarkImage(@Res() res: Response) {
    const { bytes, mimeType } = await this.settings.getImage();
    res.setHeader("Content-Type", mimeType);
    res.setHeader("Cache-Control", "private, max-age=300");
    res.send(bytes);
  }
}
