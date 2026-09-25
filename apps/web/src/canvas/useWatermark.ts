import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { WatermarkConfig } from "../lib/types";

export interface WatermarkOverlay {
  image: ImageBitmap;
  opacity: number;
}

/**
 * The site-wide watermark (if the admin has configured one) that `SceneCanvas` tiles over the live canvas. A single
 * lightweight config fetch either way; the image itself is only ever fetched when one is actually configured, so an
 * unwatermarked site costs nothing beyond that one small request.
 */
export function useWatermark(): WatermarkOverlay | null {
  const [overlay, setOverlay] = useState<WatermarkOverlay | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const config = await api.get<{ watermark: null } | WatermarkConfig>("/settings/watermark");
      if (cancelled || !("url" in config)) return;
      const blob = await api.blob(config.url);
      if (cancelled) return;
      const image = await createImageBitmap(blob);
      if (cancelled) return;
      setOverlay({ image, opacity: config.opacity });
    })().catch(() => {
      /* No watermark configured, or the request failed — render nothing rather than block the canvas. */
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return overlay;
}
