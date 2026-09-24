import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { coverCrop, createDomBuffer, uploadImageRequests } from "@psd-studio/canvas-renderer";
import { referencedAssetIds, toFieldOverrides, type CropRect, type SceneGraph, type SceneNode } from "@psd-studio/scene-graph";
import { api, ApiError } from "../lib/api";
import { isTypingTarget } from "../lib/keyboard";
import type { ExportJob, Project, TemplateField } from "../lib/types";
import { SceneCanvas, handleZoomKey, type ImageDrop, type SceneCanvasHandle } from "../canvas/SceneCanvas";
import { findNode } from "../canvas/sceneTree";
import { MAX_DECODE_DIMENSION, useLayerImages } from "../canvas/useLayerImages";
import type { View } from "../canvas/viewport";
import { CropOverlay } from "./CropOverlay";
import { TextEditOverlay } from "./TextEditOverlay";
import { FIELD_KIND, authoredText, checkImageFile, checkText, exportNotes, imageRules, isImageField, mimeList, textRules, upscaleFactor, type FieldValue } from "./fields";
import { useFieldValues } from "./useFieldValues";

/** Above this, an upload is visibly enlarged in the export. */
const SOFT_UPSCALE = 1.5;
/** End users have no view-only layer toggles: the canvas shows exactly the project's own visibility values. */
const NO_VIEW_VISIBILITY: ReadonlyMap<string, boolean> = new Map();

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? (err.detail ?? err.title) : fallback;
}

const SAVE_LABEL = { saved: "All changes saved", saving: "Saving…", error: "Some changes couldn't be saved" } as const;

export function ProjectEditorPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [project, setProject] = useState<Project | null>(null);
  const [graph, setGraph] = useState<SceneGraph | null>(null);
  const [fields, setFields] = useState<TemplateField[]>([]);
  const { values, set, flush, reset, saveErrors, saveState } = useFieldValues(projectId);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ fieldId: string; mode: "text" | "crop" } | null>(null);
  const [uploadErrors, setUploadErrors] = useState<Record<string, string>>({});
  const [uploading, setUploading] = useState<ReadonlySet<string>>(new Set());
  const [fileNames, setFileNames] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [exportFormat, setExportFormat] = useState<ExportJob["outputFormat"]>("PNG");
  const [exportJob, setExportJob] = useState<ExportJob | null>(null);
  const [exporting, setExporting] = useState(false);
  const canvasRef = useRef<SceneCanvasHandle>(null);
  const blockRefs = useRef(new Map<string, HTMLDivElement>());
  const fileInputs = useRef(new Map<string, HTMLInputElement>());
  const measure = useMemo(() => createDomBuffer(1, 1), []);

  useEffect(() => {
    if (!projectId) return;
    const load = async () => {
      const p = await api.get<Project>(`/projects/${projectId}`);
      const base = `/templates/${p.templateId}/versions/${p.templateVersionId}`;
      const [g, f] = await Promise.all([api.get<SceneGraph>(`${base}/scene-graph`), api.get<TemplateField[]>(`${base}/fields`)]);
      reset(Object.fromEntries((p.fieldValues ?? []).map((fv) => [fv.templateFieldId, fv.value as FieldValue])));
      setFields([...f].sort((a, b) => a.order - b.order));
      setGraph(g);
      setProject(p);
    };
    load().catch((err: unknown) => setError(errorMessage(err, "Could not open this project.")));
  }, [projectId, reset]);

  const nodes = useMemo(() => new Map(fields.flatMap((f) => (graph ? [[f.id, findNode(graph.root, f.nodeId)] as const] : []))), [fields, graph]);
  const fieldByNode = useMemo(() => new Map(fields.map((f) => [f.nodeId, f])), [fields]);
  const selectedField = fields.find((f) => f.id === selectedId);

  // The same merge the server's preview/export uses, so the canvas paints exactly what will be exported.
  const overrides = useMemo(() => toFieldOverrides(fields.flatMap((f) => (values[f.id] ? [{ nodeId: f.nodeId, value: values[f.id] }] : []))), [fields, values]);
  const uploadRequests = uploadImageRequests(overrides, MAX_DECODE_DIMENSION);
  const uploadKey = uploadRequests.map((r) => r.assetId).join(",");
  // Stable while typing, so the image store only reloads when the set of uploads changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const uploads = useMemo(() => uploadRequests, [uploadKey]);

  const layerAssetIds = useMemo(() => (graph ? referencedAssetIds(graph) : new Set<string>()), [graph]);
  const fetchAsset = useCallback(
    (assetId: string, signal: AbortSignal) =>
      layerAssetIds.has(assetId)
        ? api.blob(`/templates/${project!.templateId}/versions/${project!.templateVersionId}/layer-assets/${encodeURIComponent(assetId)}`, signal)
        : api.blob(`/projects/${projectId}/assets/${encodeURIComponent(assetId)}`, signal),
    [layerAssetIds, project, projectId],
  );
  const layerImages = useLayerImages(`project:${projectId}`, graph, fetchAsset, uploads);

  const select = (fieldId: string | null, reveal = false) => {
    setSelectedId(fieldId);
    const block = fieldId ? blockRefs.current.get(fieldId) : undefined;
    if (!block || !reveal) return;
    block.scrollIntoView({ block: "nearest", behavior: "smooth" });
    block.focus({ preventScroll: true });
  };

  const currentText = (field: TemplateField) => {
    const value = values[field.id];
    const node = nodes.get(field.id);
    return value?.type === "text" ? value.text : node?.type === "text" ? authoredText(node) : "";
  };
  const isShown = (field: TemplateField) => {
    const value = values[field.id];
    return value?.type === "visibility" ? value.visible : (nodes.get(field.id)?.visible ?? false);
  };
  const textCheck = (field: TemplateField) => {
    const node = nodes.get(field.id);
    return node?.type === "text" ? checkText(measure, node, currentText(field), textRules(field)) : { error: null, warnings: [] };
  };

  const editText = (field: TemplateField, text: string) => {
    const node = nodes.get(field.id);
    if (node?.type !== "text") return;
    set(field.id, { type: "text", text }, checkText(measure, node, text, textRules(field)).error ? "local" : "debounced");
  };

  const setCrop = (field: TemplateField, crop: CropRect, final: boolean) => {
    const value = values[field.id];
    if (value?.type === "image") set(field.id, { ...value, crop }, final ? "now" : "local");
  };

  const setShown = (field: TemplateField, visible: boolean) => set(field.id, { type: "visibility", visible }, "now");

  const setUploadError = (fieldId: string, message: string | null) =>
    setUploadErrors(({ [fieldId]: _, ...rest }) => (message ? { ...rest, [fieldId]: message } : rest));

  const replaceImage = async (field: TemplateField, file: File) => {
    select(field.id, true);
    setUploadError(field.id, null);
    const problem = await checkImageFile(file, imageRules(field));
    if (problem) return setUploadError(field.id, problem);
    setUploading((prev) => new Set(prev).add(field.id));
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("fieldId", field.id);
      const result = await api.upload<{ assetId: string; width: number; height: number }>(`/projects/${projectId}/uploads`, form);
      set(field.id, { type: "image", imageAssetId: result.assetId, crop: coverCrop(nodes.get(field.id)!.bounds, result.width / result.height) }, "now");
      setFileNames((prev) => ({ ...prev, [field.id]: file.name }));
    } catch (err) {
      setUploadError(field.id, errorMessage(err, "Upload failed — check the field's size and type requirements."));
    } finally {
      setUploading((prev) => {
        const next = new Set(prev);
        next.delete(field.id);
        return next;
      });
    }
  };

  const activate = (field: TemplateField) => {
    select(field.id);
    if (field.fieldType === "TEXT") setEditing({ fieldId: field.id, mode: "text" });
    else if (isImageField(field)) {
      if (values[field.id]?.type === "image") setEditing({ fieldId: field.id, mode: "crop" });
      else fileInputs.current.get(field.id)?.click();
    } else setShown(field, !isShown(field));
  };

  const isPickable = useCallback(
    (node: SceneNode) => {
      if (node.type === "group") return true;
      const field = fieldByNode.get(node.id);
      // Show/hide layers are toggled from their chip; a visible one mustn't swallow clicks meant for what it overlays.
      return !!field && field.fieldType !== "VISIBILITY";
    },
    [fieldByNode],
  );

  const imageDrop: ImageDrop = {
    rejectReason: (node, mimeType) => {
      if (!node) return "Drop the image onto a photo in your design.";
      const field = fieldByNode.get(node.id);
      if (!field) return `“${node.name}” is part of the template's design and can't be changed.`;
      if (!isImageField(field)) return `“${field.label}” is a ${FIELD_KIND[field.fieldType]} field; drop images onto a photo.`;
      const { allowedMimeTypes } = imageRules(field);
      return mimeType && !allowedMimeTypes.includes(mimeType) ? `“${field.label}” accepts ${mimeList(allowedMimeTypes)} images.` : null;
    },
    onDrop: (node, file) => void replaceImage(fieldByNode.get(node.id)!, file),
    passThrough: (node) => fieldByNode.get(node.id)?.fieldType === "VISIBILITY",
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      const onBlock = e.target === document.body || (e.target instanceof Element && e.target.classList.contains("field-block"));
      if (e.key === "Escape") {
        setEditing(null);
        select(null);
      } else if (e.key === "Enter" && onBlock && selectedField) activate(selectedField);
      else if (!handleZoomKey(e, canvasRef.current)) return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // A text field whose current value can't be saved (e.g. an emptied required field) keeps its last saved value.
  const invalid = fields.find((f) => f.fieldType === "TEXT" && textCheck(f).error);

  const requestExport = async () => {
    if (!projectId) return;
    setError(null);
    if (invalid) {
      setError(`Fix “${invalid.label}” before exporting: ${textCheck(invalid).error}`);
      return select(invalid.id, true);
    }
    setExporting(true);
    try {
      // Exports render what's saved, so land every pending edit first.
      if (!(await flush())) {
        setError("Some changes couldn't be saved, so the export wouldn't include them. Fix the fields marked below and try again.");
        return;
      }
      let job = await api.post<ExportJob>("/exports", { projectId, format: exportFormat, dpiScale: 1 });
      setExportJob(job);
      for (let i = 0; i < 40 && job.status !== "COMPLETE" && job.status !== "FAILED"; i++) {
        await sleep(500);
        job = await api.get<ExportJob>(`/exports/${job.id}`);
        setExportJob(job);
      }
      if (job.status === "FAILED") setError(job.error ?? "Export failed.");
    } catch (err) {
      setError(errorMessage(err, "Could not start export."));
    } finally {
      setExporting(false);
    }
  };

  if (!project || !graph) return error ? <div className="error-box">{error}</div> : <p>Loading…</p>;

  const canvasStatus =
    layerImages.failed > 0
      ? `${layerImages.failed} image(s) failed to load`
      : layerImages.loaded < layerImages.total
        ? `Loading layers ${layerImages.loaded}/${layerImages.total}…`
        : uploading.size > 0
          ? "Uploading photo…"
          : null;

  const editingField = editing && fields.find((f) => f.id === editing.fieldId);

  const renderOverlay = (view: View) => {
    const editNode = editingField ? nodes.get(editingField.id) : null;
    const editValue = editingField ? values[editingField.id] : undefined;
    return (
      <>
        {fields.map((field) => {
          const node = nodes.get(field.id);
          if (field.fieldType !== "VISIBILITY" || !node) return null;
          const shown = isShown(field);
          return (
            <button
              key={field.id}
              type="button"
              className={`canvas-visibility-toggle${shown ? "" : " off"}`}
              style={{ left: Math.max(6, node.bounds.left * view.zoom + view.x + 6), top: Math.max(6, node.bounds.top * view.zoom + view.y + 6) }}
              aria-pressed={shown}
              aria-label={`${shown ? "Hide" : "Show"} ${field.label}`}
              title={`${shown ? "Hide" : "Show"} ${field.label}`}
              onClick={() => {
                select(field.id, true);
                setShown(field, !shown);
              }}
            >
              <EyeIcon open={shown} /> {field.label}
            </button>
          );
        })}
        {editing?.mode === "text" && editingField && editNode?.type === "text" && (
          <TextEditOverlay
            key={editingField.id}
            node={editNode}
            view={view}
            text={currentText(editingField)}
            maxLength={textRules(editingField).maxLength}
            status={textStatus(editingField)}
            onChange={(text) => editText(editingField, text)}
            onClose={() => setEditing(null)}
          />
        )}
        {editing?.mode === "crop" && editingField && editNode && editValue?.type === "image" && (
          <CropOverlay
            key={editingField.id}
            frame={editNode.bounds}
            crop={editValue.crop}
            aspect={uploadAspect(editNode, editValue)}
            image={layerImages.store?.get(editValue.imageAssetId)}
            view={view}
            label={editingField.label}
            onChange={(crop, final) => setCrop(editingField, crop, final)}
            onClose={() => setEditing(null)}
          />
        )}
      </>
    );
  };

  function uploadAspect(node: SceneNode, value: Extract<FieldValue, { type: "image" }>): number {
    const natural = layerImages.store?.naturalSize(value.imageAssetId);
    if (natural) return natural.width / natural.height;
    const { left, top, right, bottom } = node.bounds;
    return ((right - left) / value.crop.width) / ((bottom - top) / value.crop.height);
  }

  function textStatus(field: TemplateField): { message: string; tone: "ok" | "warn" | "error" } {
    const check = textCheck(field);
    const saveError = saveErrors[field.id];
    if (check.error ?? saveError) return { message: (check.error ?? saveError)!, tone: "error" };
    if (check.warnings[0]) return { message: check.warnings[0], tone: "warn" };
    return { message: saveState === "saving" ? "Saving…" : "Saved", tone: "ok" };
  }

  return (
    <div className="editor-layout">
      <div className="editor-fields">
        <h1>{project.name}</h1>
        <p className={`save-state ${invalid ? "error" : saveState}`} role="status" aria-label="Save status">
          {invalid ? `“${invalid.label}” isn't saved until it's fixed` : SAVE_LABEL[saveState]}
        </p>
        {error && <div className="error-box">{error}</div>}
        {fields.map((field) => {
          const node = nodes.get(field.id);
          const value = values[field.id];
          const notes = node ? exportNotes(measure, graph, node, value) : [];
          const problem = uploadErrors[field.id] ?? saveErrors[field.id];
          return (
            <div
              key={field.id}
              ref={(el) => {
                if (el) blockRefs.current.set(field.id, el);
                else blockRefs.current.delete(field.id);
              }}
              className={`field-block${field.id === selectedId ? " selected" : ""}`}
              tabIndex={-1}
              role="group"
              aria-label={field.label}
              onFocus={() => setSelectedId(field.id)}
            >
              <label htmlFor={`field-${field.id}`}>{field.label}</label>
              {field.fieldType === "TEXT" && <TextFieldControls field={field} text={currentText(field)} check={textCheck(field)} onChange={(text) => editText(field, text)} onEditOnCanvas={() => activate(field)} />}
              {isImageField(field) && (
                <div className="stack">
                  <input
                    id={`field-${field.id}`}
                    ref={(el) => {
                      if (el) fileInputs.current.set(field.id, el);
                      else fileInputs.current.delete(field.id);
                    }}
                    type="file"
                    accept={imageRules(field).allowedMimeTypes.join(",")}
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      e.target.value = "";
                      if (file) void replaceImage(field, file);
                    }}
                  />
                  {value?.type === "image" && node && <ImageSummary name={fileNames[field.id]} natural={layerImages.store?.naturalSize(value.imageAssetId)} node={node} crop={value.crop} onReposition={() => activate(field)} />}
                  {uploading.has(field.id) && <p className="hint">Uploading…</p>}
                  <p className="hint">
                    Drop a photo onto it on the canvas or choose a file: at least {imageRules(field).minWidthPx}×{imageRules(field).minHeightPx}px, {mimeList(imageRules(field).allowedMimeTypes)}.
                  </p>
                </div>
              )}
              {field.fieldType === "VISIBILITY" && (
                <label className="row">
                  <input id={`field-${field.id}`} type="checkbox" checked={isShown(field)} onChange={(e) => setShown(field, e.target.checked)} />
                  Show
                </label>
              )}
              {problem && <p className="field-error">{problem}</p>}
              {notes.map((note) => (
                <p key={note} className="export-note">
                  {note}
                </p>
              ))}
            </div>
          );
        })}
        {fields.length === 0 && <p className="hint">This template has no editable fields.</p>}
        {fields.length > 0 && (
          <p className="hint" style={{ padding: "0 14px" }}>
            On the canvas: click a highlighted element to select it, double-click text to type in place, double-click a photo to reposition it, and drop an
            image onto a photo to replace it. Scroll or pinch to zoom, Space+drag to pan.
          </p>
        )}

        <div className="field-block">
          <h3>Export</h3>
          <div className="row">
            <select value={exportFormat} onChange={(e) => setExportFormat(e.target.value as ExportJob["outputFormat"])} aria-label="Export format">
              <option value="PNG">PNG</option>
              <option value="JPEG">JPEG</option>
              <option value="PDF">PDF (print-ready)</option>
              <option value="TIFF">TIFF (archival)</option>
            </select>
            <button className="primary" onClick={requestExport} disabled={exporting}>
              {exporting ? "Rendering…" : "Export"}
            </button>
          </div>
          {exportJob && (
            <p style={{ marginTop: 10 }}>
              Status: <span className={`badge ${exportJob.status}`}>{exportJob.status}</span>
              {exportJob.status === "COMPLETE" && exportJob.downloadUrl && (
                <>
                  {" "}
                  — <a href={exportJob.downloadUrl}>Download</a>
                </>
              )}
            </p>
          )}
        </div>
      </div>

      <div className="editor-canvas-pane">
        <SceneCanvas
          ref={canvasRef}
          graph={graph}
          images={layerImages.store}
          imagesVersion={layerImages.version}
          visibility={NO_VIEW_VISIBILITY}
          overrides={overrides}
          selectedId={selectedField?.nodeId ?? null}
          onSelect={(node) => {
            const field = fieldByNode.get(node.id);
            if (field) select(field.id, true);
          }}
          onActivate={(node) => {
            const field = fieldByNode.get(node.id);
            if (field) activate(field);
          }}
          isPickable={isPickable}
          nodeLabel={(node) => fieldByNode.get(node.id)?.label ?? node.name}
          status={canvasStatus}
          imageDrop={imageDrop}
          renderOverlay={renderOverlay}
        />
      </div>
    </div>
  );
}

function TextFieldControls({
  field,
  text,
  check,
  onChange,
  onEditOnCanvas,
}: {
  field: TemplateField;
  text: string;
  check: { error: string | null; warnings: string[] };
  onChange: (text: string) => void;
  onEditOnCanvas: () => void;
}) {
  const { maxLength } = textRules(field);
  return (
    <>
      <textarea id={`field-${field.id}`} rows={2} value={text} maxLength={maxLength ?? undefined} onChange={(e) => onChange(e.target.value)} />
      <div className="row between hint">
        <span aria-label={`${field.label} length`}>{maxLength === null ? `${text.length} characters` : `${text.length}/${maxLength}`}</span>
        <button type="button" className="link" onClick={onEditOnCanvas}>
          Edit on canvas
        </button>
      </div>
      {check.error && <p className="field-error">{check.error}</p>}
      {check.warnings.map((w) => (
        <p key={w} className="field-warning">
          {w}
        </p>
      ))}
    </>
  );
}

function ImageSummary({
  name,
  natural,
  node,
  crop,
  onReposition,
}: {
  name: string | undefined;
  natural: { width: number; height: number } | undefined;
  node: SceneNode;
  crop: CropRect;
  onReposition: () => void;
}) {
  const factor = natural ? upscaleFactor(node, crop, natural) : 1;
  return (
    <>
      <div className="row between">
        <span className="hint">
          {name ?? "Your photo"}
          {natural && ` · ${natural.width}×${natural.height}px`}
        </span>
        <button type="button" onClick={onReposition}>
          Reposition
        </button>
      </div>
      {factor > SOFT_UPSCALE && (
        <p className="field-warning">The export enlarges this photo {factor.toFixed(1)}× to fill its frame, so it may look soft. Zoom out in Reposition or use a larger photo.</p>
      )}
    </>
  );
}

function EyeIcon({ open }: { open: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path d="M1 8s2.5-4.5 7-4.5S15 8 15 8s-2.5 4.5-7 4.5S1 8 1 8Z" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="8" cy="8" r="2" fill={open ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.3" />
      {!open && <path d="M2.5 13.5 13.5 2.5" stroke="currentColor" strokeWidth="1.3" />}
    </svg>
  );
}
