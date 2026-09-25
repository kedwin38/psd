import { useEffect, useRef, useState } from "react";
import { ShieldAlert, Trash2, UploadCloud } from "lucide-react";
import { api, ApiError } from "../lib/api";
import type { WatermarkConfig } from "../lib/types";
import { useStepUp } from "../components/StepUpDialog";
import { Spinner } from "../components/workspace";

const MIN_OPACITY = 0.05;
const MAX_OPACITY = 0.4;
const DEFAULT_OPACITY = 0.15;

const errorText = (err: unknown, fallback: string) => (err instanceof ApiError ? (err.detail ?? err.title) : fallback);

export function SettingsAdminPage() {
  const [watermark, setWatermark] = useState<WatermarkConfig | null>(null);
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const [opacity, setOpacity] = useState(DEFAULT_OPACITY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const { stepUp, dialog: stepUpDialog } = useStepUp();

  const load = async () => {
    const config = await api.get<{ watermark: null } | WatermarkConfig>("/settings/watermark");
    if ("url" in config) {
      setWatermark(config);
      setOpacity(config.opacity);
      const blob = await api.blob(config.url);
      setPreviewSrc((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return URL.createObjectURL(blob);
      });
    } else {
      setWatermark(null);
      setPreviewSrc((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
      setOpacity(DEFAULT_OPACITY);
    }
  };

  useEffect(() => {
    load()
      .catch((err: unknown) => setError(errorText(err, "Could not load the watermark settings.")))
      .finally(() => setLoading(false));
    return () => {
      setPreviewSrc((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return prev;
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const run = async (action: () => Promise<unknown>, fallback: string) => {
    setError(null);
    setBusy(true);
    try {
      await action();
      await load();
    } catch (err) {
      setError(errorText(err, fallback));
    } finally {
      setBusy(false);
    }
  };

  const upload = (file: File) =>
    run(async () => {
      const stepUpToken = await stepUp();
      if (!stepUpToken) return;
      const form = new FormData();
      form.append("file", file);
      form.append("opacity", String(opacity));
      await api.upload("/admin/settings/watermark", form, stepUpToken);
    }, "Could not upload the watermark.");

  const chooseFile = () => fileInput.current?.click();

  const saveOpacity = () =>
    run(async () => {
      const stepUpToken = await stepUp();
      if (!stepUpToken) return;
      await api.patch("/admin/settings/watermark", { opacity }, stepUpToken);
    }, "Could not update the watermark opacity.");

  const remove = () => {
    if (!confirm("Remove the site watermark? It will stop appearing in every editor immediately.")) return;
    void run(async () => {
      const stepUpToken = await stepUp();
      if (!stepUpToken) return;
      await api.del("/admin/settings/watermark", stepUpToken);
    }, "Could not remove the watermark.");
  };

  if (loading) {
    return (
      <div className="center-page" style={{ color: "var(--text-dim)" }}>
        <Spinner label="Loading" />
      </div>
    );
  }

  return (
    <div className="grid-2">
      {stepUpDialog}
      <div>
        <h1>Site watermark</h1>
        <p className="subtitle">
          A faint, tiled mark shown over the live canvas in the template workspace and the project editor, to deter screenshot piracy. It never appears in an exported or
          downloaded file.
        </p>
        {error && <div className="error-box">{error}</div>}

        <div className="card">
          <h2>Preview</h2>
          {previewSrc ? (
            <div className="watermark-preview checkerboard" aria-label="Current watermark, at its live opacity">
              <div
                className="watermark-preview-tiles"
                style={{ backgroundImage: `url(${previewSrc})`, opacity }}
                role="img"
                aria-label="Tiled watermark preview"
              />
            </div>
          ) : (
            <p className="hint">No watermark is configured. Templates and projects render clean until you upload one.</p>
          )}
        </div>
      </div>

      <div className="card" style={{ height: "fit-content" }}>
        <h2>{watermark ? "Replace watermark" : "Upload watermark"}</h2>
        <div className="stack">
          <div>
            <label htmlFor="watermark-opacity">
              Opacity <span className="hint">({Math.round(opacity * 100)}%)</span>
            </label>
            <input
              id="watermark-opacity"
              type="range"
              min={MIN_OPACITY}
              max={MAX_OPACITY}
              step={0.01}
              value={opacity}
              onChange={(e) => setOpacity(Number(e.target.value))}
            />
          </div>
          <div className="row">
            <button type="button" className="primary" onClick={chooseFile} disabled={busy}>
              {busy ? <Spinner /> : <UploadCloud size={15} aria-hidden="true" />}
              {watermark ? "Replace with new PNG" : "Upload PNG"}
            </button>
            {watermark && (
              <button type="button" onClick={saveOpacity} disabled={busy}>
                Save opacity
              </button>
            )}
          </div>
          {watermark && (
            <button type="button" className="danger sm" onClick={remove} disabled={busy}>
              <Trash2 size={14} aria-hidden="true" />
              Remove watermark
            </button>
          )}
          <input
            ref={fileInput}
            type="file"
            className="visually-hidden"
            tabIndex={-1}
            aria-label="Choose a watermark PNG"
            accept="image/png"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) void upload(file);
            }}
          />
          <p className="hint">
            <ShieldAlert size={13} aria-hidden="true" /> PNG only. This replaces the site-wide watermark for every admin and end user at once, and requires step-up confirmation.
          </p>
        </div>
      </div>
    </div>
  );
}
