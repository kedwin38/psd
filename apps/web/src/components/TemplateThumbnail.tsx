import { useEffect, useRef, useState } from "react";
import { LayoutTemplate } from "lucide-react";
import { api } from "../lib/api";
import type { Template } from "../lib/types";

/** The current published version's rendered artwork, fetched once the card nears the viewport. */
export function TemplateThumbnail({ template, className = "" }: { template: Pick<Template, "id" | "name" | "currentVersionId">; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const { id, currentVersionId } = template;

  useEffect(() => {
    const el = ref.current;
    setSrc(null);
    setFailed(!currentVersionId);
    if (!el || !currentVersionId) return;
    const controller = new AbortController();
    let url: string | undefined;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        observer.disconnect();
        api
          .blob(`/templates/${id}/versions/${currentVersionId}/thumbnail`, controller.signal)
          .then((blob) => {
            url = URL.createObjectURL(blob);
            setSrc(url);
          })
          .catch(() => !controller.signal.aborted && setFailed(true));
      },
      { rootMargin: "200px" },
    );
    observer.observe(el);
    return () => {
      observer.disconnect();
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [id, currentVersionId]);

  return (
    <div ref={ref} className={`template-thumb ${className}`}>
      {src ? (
        <img src={src} alt={`${template.name} preview`} />
      ) : failed ? (
        <LayoutTemplate size={28} strokeWidth={1.6} aria-hidden="true" />
      ) : (
        <div className="skeleton" aria-hidden="true" />
      )}
    </div>
  );
}
