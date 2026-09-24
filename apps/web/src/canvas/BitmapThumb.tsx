import { useEffect, useRef } from "react";

/** Draws a decoded layer/upload bitmap into a small canvas at device resolution: "contain" (layers panel) or "cover" (photo cards). */
export function BitmapThumb({ image, width, height, fit = "contain", className }: { image: ImageBitmap | undefined; width: number; height: number; fit?: "contain" | "cover"; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const dpr = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;

  useEffect(() => {
    const ctx = ref.current?.getContext("2d");
    if (!ctx) return;
    const w = width * dpr;
    const h = height * dpr;
    ctx.clearRect(0, 0, w, h);
    if (!image) return;
    const k = (fit === "cover" ? Math.max : Math.min)(w / image.width, h / image.height);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(image, (w - image.width * k) / 2, (h - image.height * k) / 2, image.width * k, image.height * k);
  }, [image, width, height, fit, dpr]);

  return <canvas ref={ref} className={className} width={width * dpr} height={height * dpr} aria-hidden="true" />;
}
