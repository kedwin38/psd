import { useEffect, useRef, useState, type DragEvent } from "react";
import { CheckCircle2, Download, ImageUp, ScanFace, XCircle } from "lucide-react";
import { api, ApiError } from "../lib/api";
import type { IdPhotoJob, IdPhotoStandard } from "../lib/types";
import { EmptyState, Spinner } from "../components/workspace";

const errorText = (err: unknown, fallback: string) => (err instanceof ApiError ? (err.detail ?? err.title) : fallback);

const STANDARD_LABEL: Record<IdPhotoStandard, { label: string; hint: string }> = {
  US_PASSPORT: { label: "US Passport / Visa", hint: "2×2in, 300dpi — head 50–69% of frame height" },
  ICAO: { label: "ICAO / Biometric", hint: "35×45mm, 300dpi — head 70–80% of frame height" },
};

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export function IdPhotoPage() {
  const [standard, setStandard] = useState<IdPhotoStandard>("US_PASSPORT");
  const [sourcePreview, setSourcePreview] = useState<string | null>(null);
  const [job, setJob] = useState<IdPhotoJob | null>(null);
  const [outputPreview, setOutputPreview] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const polling = useRef(false);

  useEffect(
    () => () => {
      if (sourcePreview) URL.revokeObjectURL(sourcePreview);
      if (outputPreview) URL.revokeObjectURL(outputPreview);
    },
    [sourcePreview, outputPreview],
  );

  const submit = async (file: File) => {
    setError(null);
    setJob(null);
    setOutputPreview((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
    setSourcePreview((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return URL.createObjectURL(file);
    });
    setUploading(true);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("standard", standard);
      const created = await api.upload<IdPhotoJob>("/id-photos", form);
      setJob(created);
      void poll(created.id);
    } catch (err) {
      setError(errorText(err, "Could not upload this photo."));
    } finally {
      setUploading(false);
    }
  };

  const poll = async (id: string) => {
    if (polling.current) return;
    polling.current = true;
    try {
      for (let i = 0; i < 60; i++) {
        const current = await api.get<IdPhotoJob>(`/id-photos/${id}`);
        setJob(current);
        if (current.status === "COMPLETE" || current.status === "FAILED") {
          if (current.status === "COMPLETE" && current.downloadUrl) {
            // downloadUrl is an absolute, pre-signed link (not an API path), so fetch it directly rather than through api.blob().
            const res = await fetch(current.downloadUrl);
            if (res.ok) setOutputPreview(URL.createObjectURL(await res.blob()));
          }
          return;
        }
        await sleep(700);
      }
    } catch (err) {
      setError(errorText(err, "Could not check on this photo's progress."));
    } finally {
      polling.current = false;
    }
  };

  const chooseFile = () => fileInput.current?.click();

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) void submit(file);
  };

  const processing = job?.status === "QUEUED" || job?.status === "PROCESSING";

  return (
    <div className="grid-2 id-photo-page">
      <div>
        <h1>ID Photo Editor</h1>
        <p className="subtitle">
          Upload a photo and get back a compliant ID photo: auto white balance, exposure and background correction, and a precise crop from real face-landmark detection. Your face
          is never retouched — an ID photo has to show your true appearance.
        </p>
        {error && (
          <div className="error-box" role="alert">
            {error}
          </div>
        )}

        <div className="card">
          <h2>Standard</h2>
          <div className="id-photo-standards" role="radiogroup" aria-label="ID photo standard">
            {(Object.keys(STANDARD_LABEL) as IdPhotoStandard[]).map((s) => (
              <label key={s} className={`id-photo-standard-option${standard === s ? " selected" : ""}`}>
                <input type="radio" name="standard" value={s} checked={standard === s} onChange={() => setStandard(s)} disabled={uploading || processing} />
                <span className="id-photo-standard-label">{STANDARD_LABEL[s].label}</span>
                <span className="hint">{STANDARD_LABEL[s].hint}</span>
              </label>
            ))}
          </div>
        </div>

        <div className="card">
          <h2>Photo</h2>
          <div
            className={`id-photo-dropzone${dragOver ? " drag-over" : ""}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            onClick={chooseFile}
            role="button"
            tabIndex={0}
            aria-label="Choose or drop a photo"
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") chooseFile();
            }}
          >
            {sourcePreview ? <img src={sourcePreview} alt="Your uploaded photo" className="id-photo-dropzone-preview" /> : <ImageUp size={28} aria-hidden="true" />}
            <p>{sourcePreview ? "Drop or choose a different photo" : "Drop a photo here, or click to choose one"}</p>
          </div>
          <input
            ref={fileInput}
            type="file"
            className="visually-hidden"
            tabIndex={-1}
            aria-label="Choose a photo"
            accept="image/png,image/jpeg,image/webp"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) void submit(file);
            }}
          />
        </div>
      </div>

      <div className="card" style={{ height: "fit-content" }}>
        <h2>Result</h2>
        {!job && !uploading && (
          <EmptyState icon={<ScanFace size={20} />} title="Nothing processed yet">
            Choose a standard and upload a photo to get started.
          </EmptyState>
        )}
        {(uploading || processing) && (
          <div className="id-photo-processing">
            <Spinner label="Processing" />
            <p className="hint">Detecting your face, leveling and cropping, correcting lighting and background…</p>
          </div>
        )}
        {job?.status === "FAILED" && (
          <div className="error-box" role="alert">
            {job.error ?? "Processing failed."}
          </div>
        )}
        {job?.status === "COMPLETE" && job.report && (
          <div className="stack">
            {outputPreview && <img src={outputPreview} alt="Your processed ID photo" className="id-photo-result-preview checkerboard" />}
            <ul className="id-photo-checklist">
              {job.report.checks.map((check) => (
                <li key={check.label} className={check.pass ? "pass" : "fail"}>
                  {check.pass ? <CheckCircle2 size={15} aria-hidden="true" /> : <XCircle size={15} aria-hidden="true" />}
                  <div>
                    <strong>{check.label}</strong>
                    <p className="hint">{check.detail}</p>
                  </div>
                </li>
              ))}
            </ul>
            {!job.report.overallPass && (
              <p className="field-warning">
                One or more checks didn't pass — you can still download this version, but review the notes above before submitting it.
              </p>
            )}
            {job.downloadUrl && (
              <a className="btn primary" href={job.downloadUrl}>
                <Download size={15} aria-hidden="true" />
                Download {job.report.outputWidthPx}×{job.report.outputHeightPx}px PNG
              </a>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
