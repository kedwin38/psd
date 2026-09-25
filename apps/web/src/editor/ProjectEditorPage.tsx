import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { coverCrop, createDomBuffer, rasterAssetId, uploadImageRequests } from "@psd-studio/canvas-renderer";
import { referencedAssetIds, toFieldOverrides, type CropRect, type SceneGraph, type SceneNode } from "@psd-studio/scene-graph";
import { AlertCircle, AlertTriangle, CheckCircle2, ChevronRight, CloudCheck, Download, Eye, EyeOff, Folder, FolderOpen, ImageIcon, ImageUp, Info, Move, PanelLeft, PenLine, Type, X, XCircle } from "lucide-react";
import { api, ApiError } from "../lib/api";
import { isTypingTarget } from "../lib/keyboard";
import type { ExportJob, Project, TemplateField } from "../lib/types";
import { SceneCanvas, handleZoomKey, type ImageDrop, type SceneCanvasHandle } from "../canvas/SceneCanvas";
import { findNode } from "../canvas/sceneTree";
import { MAX_DECODE_DIMENSION, useLayerImages } from "../canvas/useLayerImages";
import { BitmapThumb } from "../canvas/BitmapThumb";
import type { View } from "../canvas/viewport";
import { EmptyState, MOD, PanelResizer, Popover, ShortcutsButton, Spinner, WorkspaceSkeleton, WorkspaceTopBar, usePanel, type Shortcut } from "../components/workspace";
import { CropOverlay } from "./CropOverlay";
import { TextEditOverlay } from "./TextEditOverlay";
import { buildFieldTree, type FieldEntry, type FieldGroupEntry } from "./fieldTree";
import { FIELD_KIND, authoredText, checkImageFile, checkText, exportNotes, imageRules, isImageField, mimeList, textRules, upscaleFactor, type FieldValue } from "./fields";
import { useFieldValues } from "./useFieldValues";

/** Above this, an upload is visibly enlarged in the export. */
const SOFT_UPSCALE = 1.5;
/** End users have no view-only layer toggles: the canvas shows exactly the project's own visibility values. */
const NO_VIEW_VISIBILITY: ReadonlyMap<string, boolean> = new Map();
const BACK = { to: "/", label: "Templates" };
const PHOTO_THUMB = 56;

const SHORTCUTS: readonly Shortcut[] = [
  ["Select a field", ["Click"]],
  ["Type in place / reposition a photo", ["Double-click"]],
  ["Replace a photo", ["Drop image"]],
  ["Zoom", ["Scroll", "+", "−"]],
  ["Pan", ["Space", "Drag"]],
  ["Fit to screen", [MOD, "0"]],
  ["Actual pixels", [MOD, "1"]],
  ["Finish editing / deselect", ["Esc"]],
];

const FORMAT_LABEL: Record<ExportJob["outputFormat"], string> = { PNG: "PNG", JPEG: "JPEG", PDF: "PDF", TIFF: "TIFF" };

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
  const [exportOpen, setExportOpen] = useState(false);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const canvasRef = useRef<SceneCanvasHandle>(null);
  const blockRefs = useRef(new Map<string, HTMLDivElement>());
  /** A field to scroll to once the groups just expanded to show it have rendered. */
  const pendingReveal = useRef<string | null>(null);
  const fileInputs = useRef(new Map<string, HTMLInputElement>());
  const measure = useMemo(() => createDomBuffer(1, 1), []);
  const panel = usePanel("editor-fields", 360, 316);

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
  const tree = useMemo(() => buildFieldTree(graph?.root ?? [], fields), [graph, fields]);
  const selectedGroups = (selectedId && tree.groupsOf.get(selectedId)) || [];

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

  const revealBlock = (fieldId: string) => {
    const block = blockRefs.current.get(fieldId);
    if (!block) return;
    block.scrollIntoView({ block: "nearest", behavior: "smooth" });
    block.focus({ preventScroll: true });
  };

  // A selected field's card is never left inside a collapsed group.
  const select = (fieldId: string | null, reveal = false) => {
    setSelectedId(fieldId);
    if (!fieldId) return;
    const closed = (tree.groupsOf.get(fieldId) ?? []).filter((id) => collapsed.has(id));
    if (closed.length === 0) {
      if (reveal) revealBlock(fieldId);
      return;
    }
    setCollapsed((prev) => new Set([...prev].filter((id) => !closed.includes(id))));
    if (reveal) pendingReveal.current = fieldId;
  };

  useEffect(() => {
    const fieldId = pendingReveal.current;
    if (!fieldId) return;
    pendingReveal.current = null;
    revealBlock(fieldId);
  });

  const toggleGroup = (groupId: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(groupId)) next.add(groupId);
      return next;
    });

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

  const chooseFile = (field: TemplateField) => fileInputs.current.get(field.id)?.click();

  const activate = (field: TemplateField) => {
    select(field.id);
    if (field.fieldType === "TEXT") setEditing({ fieldId: field.id, mode: "text" });
    else if (isImageField(field)) {
      if (values[field.id]?.type === "image") setEditing({ fieldId: field.id, mode: "crop" });
      else chooseFile(field);
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
      const field = node && fieldByNode.get(node.id);
      if (!field) return "Drop the image onto a photo in your design.";
      if (!isImageField(field)) return `“${field.label}” is a ${FIELD_KIND[field.fieldType]} field; drop images onto a photo.`;
      const { allowedMimeTypes } = imageRules(field);
      return mimeType && !allowedMimeTypes.includes(mimeType) ? `“${field.label}” accepts ${mimeList(allowedMimeTypes)} images.` : null;
    },
    onDrop: (node, file) => void replaceImage(fieldByNode.get(node.id)!, file),
    // Same targets as clicks: fixed design layers (e.g. a frame or gradient over a photo) don't block a drop onto the photo beneath.
    passThrough: (node) => !isPickable(node),
  };

  // Dropping a photo straight onto its field card in the panel, as well as onto the canvas.
  const cardDrop = (field: TemplateField) =>
    isImageField(field)
      ? {
          onDragOver: (e: DragEvent<HTMLDivElement>) => {
            if (!e.dataTransfer.types.includes("Files")) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
            if (dropTarget !== field.id) setDropTarget(field.id);
          },
          onDragLeave: (e: DragEvent<HTMLDivElement>) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropTarget(null);
          },
          onDrop: (e: DragEvent<HTMLDivElement>) => {
            if (!e.dataTransfer.types.includes("Files")) return;
            e.preventDefault();
            setDropTarget(null);
            const file = e.dataTransfer.files[0];
            if (file) void replaceImage(field, file);
          },
        }
      : {};

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
    setExportJob(null);
    setExportOpen(true);
    try {
      // Exports render what's saved, so land every pending edit first.
      if (!(await flush())) {
        setExportOpen(false);
        setError("Some changes couldn't be saved, so the export wouldn't include them. Fix the fields marked in the panel and try again.");
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
      setExportOpen(false);
      setError(errorMessage(err, "Could not start export."));
    } finally {
      setExporting(false);
    }
  };

  if (!project || !graph) {
    if (!error) return <WorkspaceSkeleton right={false} label="Opening project" />;
    return (
      <div className="ws">
        <WorkspaceTopBar back={BACK} title="Project" />
        <div className="ws-state">
          <div className="ws-state-card">
            <EmptyState
              icon={<AlertCircle size={22} />}
              tone="danger"
              title="This project couldn't be opened"
              actions={
                <Link className="btn primary" to={BACK.to}>
                  Back to templates
                </Link>
              }
            >
              {error}
            </EmptyState>
          </div>
        </div>
      </div>
    );
  }

  const layersLoading = layerImages.loaded < layerImages.total;
  const canvasStatus =
    layerImages.failed > 0
      ? `${layerImages.failed} image(s) failed to load`
      : layersLoading
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
              {shown ? <Eye size={14} aria-hidden="true" /> : <EyeOff size={14} aria-hidden="true" />} {field.label}
            </button>
          );
        })}
        {editing?.mode === "text" && editingField && editNode?.type === "text" && (
          <TextEditOverlay
            key={editingField.id}
            node={editNode}
            label={editingField.label}
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

  const renderField = (field: TemplateField) => {
    const node = nodes.get(field.id);
    const value = values[field.id];
    const notes = node ? exportNotes(measure, graph, node, value) : [];
    const problem = uploadErrors[field.id] ?? saveErrors[field.id];
    const Icon = field.fieldType === "TEXT" ? Type : isImageField(field) ? ImageIcon : Eye;
    return (
      <div
        key={field.id}
        ref={(el) => {
          if (el) blockRefs.current.set(field.id, el);
          else blockRefs.current.delete(field.id);
        }}
        className={`field-block${field.id === selectedId ? " selected" : ""}${dropTarget === field.id ? " drop-target" : ""}`}
        tabIndex={-1}
        role="group"
        aria-label={field.label}
        onFocus={() => setSelectedId(field.id)}
        {...cardDrop(field)}
      >
        <div className="field-head">
          <span className="f-icon">
            <Icon size={14} aria-hidden="true" />
          </span>
          {isImageField(field) ? <span className="field-title">{field.label}</span> : <label htmlFor={`field-${field.id}`}>{field.label}</label>}
          <span className="field-kind">{FIELD_KIND[field.fieldType]}</span>
        </div>
        {field.fieldType === "TEXT" && <TextFieldControls field={field} text={currentText(field)} check={textCheck(field)} onChange={(text) => editText(field, text)} onEditOnCanvas={() => activate(field)} />}
        {isImageField(field) && node && (
          <PhotoField
            field={field}
            node={node}
            value={value?.type === "image" ? value : undefined}
            name={fileNames[field.id]}
            images={layerImages.store}
            uploading={uploading.has(field.id)}
            inputRef={(el) => {
              if (el) fileInputs.current.set(field.id, el);
              else fileInputs.current.delete(field.id);
            }}
            onFile={(file) => void replaceImage(field, file)}
            onChoose={() => chooseFile(field)}
            onReposition={() => activate(field)}
          />
        )}
        {field.fieldType === "VISIBILITY" && (
          <label className="switch-row">
            <span>
              Show on design
              <span className="sub">You can also toggle it from its chip on the canvas.</span>
            </span>
            <input id={`field-${field.id}`} type="checkbox" className="switch" checked={isShown(field)} onChange={(e) => setShown(field, e.target.checked)} />
          </label>
        )}
        {problem && (
          <p className="field-error">
            <XCircle size={14} aria-hidden="true" />
            <span>{problem}</span>
          </p>
        )}
        {notes.map((note) => (
          <p key={note} className="export-note">
            {note}
          </p>
        ))}
      </div>
    );
  };

  const renderEntries = (entries: readonly FieldEntry[]): ReactNode =>
    entries.map((entry) =>
      entry.kind === "field" ? (
        renderField(entry.field)
      ) : (
        <FieldGroup key={entry.node.id} group={entry} open={!collapsed.has(entry.node.id)} holdsSelection={selectedGroups.includes(entry.node.id)} onToggle={() => toggleGroup(entry.node.id)}>
          {renderEntries(entry.entries)}
        </FieldGroup>
      ),
    );

  const saveTone = invalid ? "error" : saveState;
  const bodyStyle = { "--left-w": `${panel.collapsed ? 0 : panel.width}px` } as CSSProperties;

  return (
    <div className="ws editor-ws">
      <WorkspaceTopBar
        back={BACK}
        title={project.name}
        meta={
          <p className={`save-pill save-state ${saveTone}`} role="status" aria-label="Save status">
            {saveTone === "saving" ? <Spinner /> : saveTone === "error" ? <AlertCircle size={14} aria-hidden="true" /> : <CloudCheck size={15} aria-hidden="true" />}
            <span className={saveTone === "saved" ? "hide-sm" : undefined}>{invalid ? `“${invalid.label}” isn't saved until it's fixed` : SAVE_LABEL[saveState]}</span>
          </p>
        }
        end={
          <>
            <button type="button" className="icon-btn panel-toggle" aria-pressed={!panel.collapsed} aria-label="Fields panel" data-tip={panel.collapsed ? "Show fields" : "Hide fields"} onClick={panel.toggle}>
              <PanelLeft size={18} aria-hidden="true" />
            </button>
            <ShortcutsButton shortcuts={SHORTCUTS} />
            <span className="ws-divider" aria-hidden="true" />
            <div className="export-controls">
              <select value={exportFormat} onChange={(e) => setExportFormat(e.target.value as ExportJob["outputFormat"])} aria-label="Export format">
                <option value="PNG">PNG</option>
                <option value="JPEG">JPEG</option>
                <option value="PDF">PDF (print-ready)</option>
                <option value="TIFF">TIFF (archival)</option>
              </select>
              <Popover
                open={exportOpen}
                onOpenChange={(open) => !exporting && setExportOpen(open)}
                className="export-status"
                trigger={({ "aria-expanded": expanded }) => (
                  <button className="primary" onClick={requestExport} disabled={exporting} aria-expanded={expanded}>
                    {exporting ? <Spinner /> : <Download size={15} aria-hidden="true" />}
                    Export
                  </button>
                )}
              >
                <ExportStatus job={exportJob} format={exportFormat} onClose={() => setExportOpen(false)} />
              </Popover>
            </div>
          </>
        }
      />

      <div className={`ws-body no-right editor-layout${panel.collapsed ? " left-collapsed" : ""}`} style={bodyStyle}>
        <aside className="panel left editor-fields" aria-label="Fields panel">
          <div className="panel-inner" inert={panel.collapsed}>
            <div className="panel-header">
              <h2 className="panel-title">
                Your content <span className="panel-count">{fields.length}</span>
              </h2>
            </div>
            <div className="panel-body">
              {renderEntries(tree.entries)}
              {fields.length === 0 && (
                <EmptyState icon={<Info size={20} />} title="Nothing to customize">
                  This template has no editable fields. You can still export it as-is.
                </EmptyState>
              )}
            </div>
            {fields.length > 0 && (
              <div className="panel-footer editor-tip">
                <Info size={14} aria-hidden="true" />
                <span>Double-click text on the canvas to type in place, or a photo to reposition it. Drop an image onto a photo to replace it.</span>
              </div>
            )}
          </div>
          <PanelResizer side="left" width={panel.width} min={280} max={480} onResize={panel.setWidth} onReset={panel.reset} label="Resize fields panel" />
        </aside>

        <main className="ws-canvas editor-canvas-pane">
          {error && (
            <div className="error-box ws-canvas-banner" role="alert">
              <AlertCircle size={16} aria-hidden="true" />
              <span>{error}</span>
              <button type="button" className="icon-btn sm dismiss" aria-label="Dismiss" onClick={() => setError(null)}>
                <X size={15} aria-hidden="true" />
              </button>
            </div>
          )}
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
            statusTone={layerImages.failed > 0 ? "error" : "busy"}
            loading={layersLoading}
            imageDrop={imageDrop}
            renderOverlay={renderOverlay}
            artboardLabel={project.name}
          />
        </main>
      </div>
    </div>
  );
}

function ExportStatus({ job, format, onClose }: { job: ExportJob | null; format: ExportJob["outputFormat"]; onClose: () => void }) {
  const status = job?.status ?? "QUEUED";
  const label = FORMAT_LABEL[job?.outputFormat ?? format];
  const done = status === "COMPLETE";
  const failed = status === "FAILED";
  return (
    <div role="status" aria-label="Export status">
      <div className="status-row">
        {done ? <CheckCircle2 size={20} color="var(--success-500)" aria-hidden="true" /> : failed ? <XCircle size={20} color="var(--danger-500)" aria-hidden="true" /> : <Spinner />}
        <span className="grow">{done ? `Your ${label} is ready` : failed ? "Export failed" : `Rendering ${label}…`}</span>
        <span className={`badge ${status}`}>{status}</span>
        {(done || failed) && (
          <button type="button" className="icon-btn sm" aria-label="Close" onClick={onClose}>
            <X size={15} aria-hidden="true" />
          </button>
        )}
      </div>
      <p className="sub">
        {done
          ? "Rendered on the server at the template's native resolution."
          : failed
            ? (job?.error ?? "Something went wrong while rendering. Try again in a moment.")
            : "Saving your latest edits and rendering at full quality."}
      </p>
      {done && job?.downloadUrl && (
        <a className="btn primary" href={job.downloadUrl}>
          <Download size={15} aria-hidden="true" />
          Download
        </a>
      )}
    </div>
  );
}

/** A PSD group's fields, indented under a header that collapses them; the header lights up while a field inside is selected. */
function FieldGroup({ group, open, holdsSelection, onToggle, children }: { group: FieldGroupEntry; open: boolean; holdsSelection: boolean; onToggle: () => void; children: ReactNode }) {
  const bodyId = `field-group-${group.node.id}`;
  const count = `${group.count} ${group.count === 1 ? "field" : "fields"}`;
  return (
    <div className={`field-group${holdsSelection ? " holds-selection" : ""}`}>
      <button type="button" className="ghost field-group-head" aria-expanded={open} aria-controls={bodyId} aria-label={`${group.node.name}, ${count}`} title={`${open ? "Collapse" : "Expand"} ${group.node.name}`} onClick={onToggle}>
        <ChevronRight className="field-group-caret" size={14} aria-hidden="true" />
        {open ? <FolderOpen size={15} aria-hidden="true" /> : <Folder size={15} aria-hidden="true" />}
        <span className="field-group-name">{group.node.name}</span>
        <span className="field-group-count" aria-hidden="true">
          {group.count}
        </span>
      </button>
      <div id={bodyId} className="field-group-body" hidden={!open}>
        {children}
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
      <div className="field-meta">
        <span aria-label={`${field.label} length`}>{maxLength === null ? `${text.length} characters` : `${text.length}/${maxLength}`}</span>
        <button type="button" className="ghost" onClick={onEditOnCanvas}>
          <PenLine size={13} aria-hidden="true" />
          Edit on canvas
        </button>
      </div>
      {check.error && (
        <p className="field-error">
          <XCircle size={14} aria-hidden="true" />
          <span>{check.error}</span>
        </p>
      )}
      {check.warnings.map((w) => (
        <p key={w} className="field-warning">
          <AlertTriangle size={14} aria-hidden="true" />
          <span>{w}</span>
        </p>
      ))}
    </>
  );
}

function PhotoField({
  field,
  node,
  value,
  name,
  images,
  uploading,
  inputRef,
  onFile,
  onChoose,
  onReposition,
}: {
  field: TemplateField;
  node: SceneNode;
  value: Extract<FieldValue, { type: "image" }> | undefined;
  name: string | undefined;
  images: ReturnType<typeof useLayerImages>["store"];
  uploading: boolean;
  inputRef: (el: HTMLInputElement | null) => void;
  onFile: (file: File) => void;
  onChoose: () => void;
  onReposition: () => void;
}) {
  const rules = imageRules(field);
  const placeholderId = rasterAssetId(node);
  const natural = value ? images?.naturalSize(value.imageAssetId) : undefined;
  const bitmap = value ? images?.get(value.imageAssetId) : placeholderId ? images?.get(placeholderId) : undefined;
  const factor = value && natural ? upscaleFactor(node, value.crop, natural) : 1;
  return (
    <>
      <div className="photo-field">
        <div className="photo-thumb checkerboard">
          <BitmapThumb image={bitmap} width={PHOTO_THUMB} height={PHOTO_THUMB} fit="cover" />
          {uploading && (
            <div className="busy">
              <Spinner label="Uploading photo" />
            </div>
          )}
        </div>
        <div className="photo-info">
          <span className="photo-name" title={name}>
            {value ? `${name ?? "Your photo"}${natural ? ` · ${natural.width}×${natural.height}px` : ""}` : "Template placeholder"}
          </span>
          <div className="actions">
            <button type="button" className="sm" onClick={onChoose} disabled={uploading}>
              <ImageUp size={14} aria-hidden="true" />
              {value ? "Replace" : "Upload photo"}
            </button>
            {value && (
              <button type="button" className="sm ghost" onClick={onReposition}>
                <Move size={14} aria-hidden="true" />
                Reposition
              </button>
            )}
          </div>
        </div>
        <input
          id={`field-${field.id}`}
          ref={inputRef}
          type="file"
          className="visually-hidden"
          tabIndex={-1}
          aria-label={`Choose a photo for ${field.label}`}
          accept={rules.allowedMimeTypes.join(",")}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) onFile(file);
          }}
        />
      </div>
      <p className="photo-rules">
        At least {rules.minWidthPx}×{rules.minHeightPx}px · {mimeList(rules.allowedMimeTypes)} · or drop one here
      </p>
      {factor > SOFT_UPSCALE && (
        <p className="field-warning">
          <AlertTriangle size={14} aria-hidden="true" />
          <span>The export enlarges this photo {factor.toFixed(1)}× to fill its frame, so it may look soft. Zoom out in Reposition or use a larger photo.</span>
        </p>
      )}
    </>
  );
}
