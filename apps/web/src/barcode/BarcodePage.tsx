import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from "react";
import { CheckCircle2, ClipboardPaste, Download, QrCode } from "lucide-react";
import { api, ApiError } from "../lib/api";
import { EmptyState, Spinner } from "../components/workspace";

const errorText = (err: unknown, fallback: string) => (err instanceof ApiError ? (err.detail ?? err.title) : fallback);

interface BarcodeExtraction {
  text: string;
  format: string;
  width: number;
  height: number;
  downloadUrl: string;
}

/** Pulls the first image out of a clipboard item list, whichever the OS/browser labelled it. */
async function firstImageFromClipboardItem(item: ClipboardItem): Promise<Blob | null> {
  const imageType = item.types.find((t) => t.startsWith("image/"));
  return imageType ? item.getType(imageType) : null;
}

export function BarcodePage() {
  const [sourcePreview, setSourcePreview] = useState<string | null>(null);
  const [result, setResult] = useState<BarcodeExtraction | null>(null);
  const [resultPreview, setResultPreview] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const canPasteViaApi = typeof navigator !== "undefined" && "clipboard" in navigator && "read" in navigator.clipboard;
  const dropzone = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(
    () => () => {
      if (sourcePreview) URL.revokeObjectURL(sourcePreview);
      if (resultPreview) URL.revokeObjectURL(resultPreview);
    },
    [sourcePreview, resultPreview],
  );

  const submit = async (blob: Blob) => {
    setError(null);
    setResult(null);
    setResultPreview((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
    setSourcePreview((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return URL.createObjectURL(blob);
    });
    setProcessing(true);
    try {
      const form = new FormData();
      form.append("file", blob, "pasted-image");
      const extracted = await api.upload<BarcodeExtraction>("/barcodes/extract", form);
      setResult(extracted);
      const res = await fetch(extracted.downloadUrl);
      if (res.ok) setResultPreview(URL.createObjectURL(await res.blob()));
    } catch (err) {
      setError(errorText(err, "Could not extract a barcode from that image."));
    } finally {
      setProcessing(false);
    }
  };

  const pasteFromClipboard = async () => {
    setError(null);
    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const blob = await firstImageFromClipboardItem(item);
        if (blob) {
          void submit(blob);
          return;
        }
      }
      setError(
        "No image data was found on your clipboard. If you copied a file (e.g. from your file manager, or Copy on a saved image), that isn't image data the browser can read — " +
          "try opening the image itself and using \"Copy image\", pressing Ctrl/Cmd+V in the box below, or just drop/choose the file directly.",
      );
    } catch {
      setError("Couldn't read your clipboard. Your browser may need permission — try pressing Ctrl/Cmd+V in the box below instead, or drop/choose the file directly.");
    }
  };

  const onPasteEvent = (e: ClipboardEvent<HTMLDivElement>) => {
    const item = Array.from(e.clipboardData.items).find((i) => i.type.startsWith("image/"));
    if (!item) return;
    e.preventDefault();
    const blob = item.getAsFile();
    if (blob) void submit(blob);
  };

  const chooseFile = () => fileInput.current?.click();

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) void submit(file);
  };

  return (
    <div className="grid-2 id-photo-page">
      <div>
        <h1>Barcode Extractor</h1>
        <p className="subtitle">
          Paste an image containing a barcode — a screenshot, a photo, anything with a barcode somewhere in it — and get back just the barcode itself, cropped tight and upscaled
          for a crisp, high-quality PNG download.
        </p>
        {error && (
          <div className="error-box" role="alert">
            {error}
          </div>
        )}

        <div className="card">
          <h2>Image</h2>
          <div
            ref={dropzone}
            className={`id-photo-dropzone${dragOver ? " drag-over" : ""}`}
            onPaste={onPasteEvent}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            onClick={chooseFile}
            tabIndex={0}
            role="button"
            aria-label="Paste, drop, or choose an image containing a barcode"
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") chooseFile();
            }}
          >
            {sourcePreview ? <img src={sourcePreview} alt="Your pasted image" className="id-photo-dropzone-preview" /> : <QrCode size={28} aria-hidden="true" />}
            <p>{sourcePreview ? "Paste, drop, or click to choose a different image" : "Drop an image here, click to choose one, or press Ctrl/Cmd+V"}</p>
          </div>
          <input
            ref={fileInput}
            type="file"
            className="visually-hidden"
            tabIndex={-1}
            aria-label="Choose an image"
            accept="image/png,image/jpeg,image/webp"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) void submit(file);
            }}
          />
          <button type="button" className="btn primary" onClick={() => void pasteFromClipboard()} disabled={processing} style={{ marginTop: "0.75rem" }}>
            <ClipboardPaste size={15} aria-hidden="true" />
            {canPasteViaApi ? "Paste from clipboard" : "Paste (Ctrl/Cmd+V in the box above)"}
          </button>
        </div>
      </div>

      <div className="card" style={{ height: "fit-content" }}>
        <h2>Result</h2>
        {!result && !processing && (
          <EmptyState icon={<QrCode size={20} />} title="Nothing extracted yet">
            Paste an image with a barcode in it to get started.
          </EmptyState>
        )}
        {processing && (
          <div className="id-photo-processing">
            <Spinner label="Extracting" />
            <p className="hint">Locating the barcode and cropping out everything else…</p>
          </div>
        )}
        {result && (
          <div className="stack">
            {resultPreview && <img src={resultPreview} alt="Extracted barcode" className="id-photo-result-preview checkerboard" />}
            <ul className="id-photo-checklist">
              <li className="pass">
                <CheckCircle2 size={15} aria-hidden="true" />
                <div>
                  <strong>Decoded value</strong>
                  <p className="hint">{result.text}</p>
                </div>
              </li>
              <li className="pass">
                <CheckCircle2 size={15} aria-hidden="true" />
                <div>
                  <strong>Format</strong>
                  <p className="hint">{result.format.replace(/_/g, " ")}</p>
                </div>
              </li>
            </ul>
            <a className="btn primary" href={result.downloadUrl}>
              <Download size={15} aria-hidden="true" />
              Download {result.width}×{result.height}px PNG
            </a>
          </div>
        )}
      </div>
    </div>
  );
}
