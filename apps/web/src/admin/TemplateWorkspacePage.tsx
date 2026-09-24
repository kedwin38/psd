import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { SceneGraph, SceneNode } from "@psd-studio/scene-graph";
import { AlertCircle, AlertTriangle, Box, Check, ChevronRight, Eye, FileWarning, Image, MousePointerClick, PanelLeft, PanelRight, Redo2, RefreshCw, Rocket, Type, Undo2, X } from "lucide-react";
import { api, ApiError } from "../lib/api";
import { stepUp } from "../lib/auth-api";
import { isTypingTarget } from "../lib/keyboard";
import type { FieldType, Template, TemplateField, TemplateVersion } from "../lib/types";
import { SceneCanvas, handleZoomKey, type ImageDrop, type SceneCanvasHandle } from "../canvas/SceneCanvas";
import { ancestorIds, findNode, withNodeUpdate } from "../canvas/sceneTree";
import { useLayerImages } from "../canvas/useLayerImages";
import { EmptyState, MOD, PanelResizer, Popover, ShortcutsButton, Spinner, WorkspaceSkeleton, WorkspaceTopBar, usePanel, type Shortcut } from "../components/workspace";
import { LayerTree, TYPE_LABEL } from "./LayerTree";
import { FIELD_TYPE_LABEL, FieldMappingForm } from "./FieldMappingForm";
import { useCommandStack, type Command } from "./useCommandStack";

const isPickable = (node: SceneNode) => !node.locked;

const INGEST_POLL_MS = 2000;
const BACK = { to: "/admin/templates", label: "Template library" };

const FIELD_ICON: Record<FieldType, typeof Type> = { TEXT: Type, IMAGE: Image, SMART_OBJECT: Box, VISIBILITY: Eye };

const SHORTCUTS: readonly Shortcut[] = [
  ["Select a layer", ["Click"]],
  ["Inspect text runs", ["Double-click"]],
  ["Zoom", ["Scroll", "+", "−"]],
  ["Pan", ["Space", "Drag"]],
  ["Fit to screen", [MOD, "0"]],
  ["Actual pixels", [MOD, "1"]],
  ["Undo / Redo", [MOD, "Z"]],
  ["Redo", ["⇧", MOD, "Z"]],
  ["Deselect", ["Esc"]],
  ["Remove selected field", ["Delete"]],
  ["Replace a placeholder image", ["Drop file"]],
];

function countNodes(nodes: readonly SceneNode[]): number {
  return nodes.reduce((n, node) => n + 1 + (node.type === "group" ? countNodes(node.children) : 0), 0);
}

function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.detail ?? (err.errors?.join("; ") || err.title);
  return err instanceof Error ? err.message : "That change could not be saved.";
}

export function TemplateWorkspacePage() {
  const { templateId, versionId } = useParams<{ templateId: string; versionId: string }>();
  const navigate = useNavigate();
  const base = `/templates/${templateId}/versions/${versionId}`;

  const [template, setTemplate] = useState<Template | null>(null);
  const [version, setVersion] = useState<TemplateVersion | null>(null);
  const [sceneGraph, setSceneGraph] = useState<SceneGraph | null>(null);
  const [fields, setFields] = useState<TemplateField[]>([]);
  /** Bumped on every field reload so the mapping form re-reads values an undo/redo changed under it. */
  const [fieldsRevision, setFieldsRevision] = useState(0);
  const fieldsRef = useRef(fields);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [visibility, setVisibility] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [saved, setSaved] = useState(false);
  const canvasRef = useRef<SceneCanvasHandle>(null);
  const commands = useCommandStack((err) => setError(errorMessage(err)));
  const leftPanel = usePanel("admin-layers", 272, 236);
  const rightPanel = usePanel("admin-inspector", 320, 280);

  const showFields = (next: TemplateField[]) => {
    fieldsRef.current = next;
    setFields(next);
    setFieldsRevision((r) => r + 1);
  };

  const load = async () => {
    if (!templateId || !versionId) return;
    const [t, v, f] = await Promise.all([api.get<Template>(`/templates/${templateId}`), api.get<TemplateVersion>(base), api.get<TemplateField[]>(`${base}/fields`)]);
    setTemplate(t);
    setVersion(v);
    showFields(f);
    if (v.ingestStatus === "READY") {
      setSceneGraph(await api.get<SceneGraph>(`${base}/scene-graph`));
    }
  };

  const tryLoad = () =>
    load().then(
      () => setLoadError(null),
      (err: unknown) => setLoadError(errorMessage(err)),
    );
  const tryLoadRef = useRef(tryLoad);
  tryLoadRef.current = tryLoad;

  useEffect(() => {
    void tryLoad();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templateId, versionId]);

  // The PSD parses in the background: keep checking until it's ready (or has failed).
  const ingesting = version?.ingestStatus === "PENDING" || version?.ingestStatus === "PARSING";
  useEffect(() => {
    if (!ingesting) return;
    const timer = setInterval(() => void tryLoadRef.current(), INGEST_POLL_MS);
    return () => clearInterval(timer);
  }, [ingesting]);

  const fetchLayerAsset = useCallback(
    (assetId: string, signal: AbortSignal) => api.blob(`/templates/${templateId}/versions/${versionId}/layer-assets/${encodeURIComponent(assetId)}`, signal),
    [templateId, versionId],
  );
  const layerImages = useLayerImages(`${templateId}/${versionId}`, sceneGraph, fetchLayerAsset);

  const mappedNodeIds = useMemo(() => new Set(fields.map((f) => f.nodeId)), [fields]);
  const selectedNode = sceneGraph && selectedNodeId ? findNode(sceneGraph.root, selectedNodeId) : null;
  const existingField = fields.find((f) => f.nodeId === selectedNodeId);

  const isVisible = useCallback((node: SceneNode) => visibility.get(node.id) ?? node.visible, [visibility]);

  const execute = (cmd: Command) => {
    setError(null);
    setSaved(true);
    void commands.execute(cmd);
  };

  const reloadFields = async () => showFields(await api.get<TemplateField[]>(`${base}/fields`));

  // Fields are unique per node, and a re-created field gets a new id, so commands address fields by node.
  const fieldIdFor = (nodeId: string) => {
    const field = fieldsRef.current.find((f) => f.nodeId === nodeId);
    if (!field) throw new Error("That field no longer exists.");
    return field.id;
  };

  const saveField = (fieldType: FieldType, label: string, constraints: Record<string, unknown>) => {
    if (!selectedNode) return;
    const node = selectedNode;
    const after = { fieldType, label, constraints };
    if (existingField) {
      const before = { fieldType: existingField.fieldType, label: existingField.label, constraints: existingField.constraints };
      const patch = (body: typeof after) => async () => {
        await api.patch(`${base}/fields/${fieldIdFor(node.id)}`, body);
        await reloadFields();
      };
      execute({ label: `edit field “${label}”`, run: patch(after), undo: patch(before) });
    } else {
      const payload = { nodeId: node.id, layerPath: node.path, order: fields.length, ...after };
      execute({ label: `create field “${label}”`, run: () => createField(payload), undo: () => deleteField(node.id) });
    }
  };

  const createField = async (payload: Omit<TemplateField, "id" | "templateVersionId">) => {
    await api.post(`${base}/fields`, payload);
    await reloadFields();
  };

  const deleteField = async (nodeId: string) => {
    await api.del(`${base}/fields/${fieldIdFor(nodeId)}`);
    await reloadFields();
  };

  const removeField = (field: TemplateField) => {
    const { nodeId, layerPath, fieldType, label, order, constraints } = field;
    execute({ label: `remove field “${label}”`, run: () => deleteField(nodeId), undo: () => createField({ nodeId, layerPath, fieldType, label, order, constraints }) });
  };

  const toggleVisible = (node: SceneNode) => {
    const prior = visibility.get(node.id);
    const next = !(prior ?? node.visible);
    const apply = (value: boolean | undefined) => () =>
      setVisibility((prev) => {
        const map = new Map(prev);
        if (value === undefined) map.delete(node.id);
        else map.set(node.id, value);
        return map;
      });
    execute({ label: `${next ? "show" : "hide"} “${node.name}”`, run: apply(next), undo: apply(prior) });
  };

  const setLocked = (nodeId: string, locked: boolean) => async () => {
    setSceneGraph((sg) => sg && withNodeUpdate(sg, nodeId, { locked }));
    try {
      await api.patch(`${base}/nodes/${nodeId}`, { locked });
    } catch (err) {
      setSceneGraph((sg) => sg && withNodeUpdate(sg, nodeId, { locked: !locked }));
      throw err;
    }
  };

  const toggleLocked = (node: SceneNode) => {
    const locked = !node.locked;
    execute({ label: `${locked ? "lock" : "unlock"} “${node.name}”`, run: setLocked(node.id, locked), undo: setLocked(node.id, !locked) });
  };

  const pointImageAt = async (nodeId: string, imageAssetId: string) => {
    await api.patch(`${base}/nodes/${nodeId}`, { imageAssetId });
    setSceneGraph((sg) => sg && withNodeUpdate(sg, nodeId, { imageAssetId }));
  };

  // Uploads once; undo/redo then just re-point the layer at the previous/new raster (both stay in the image cache).
  const replaceImage = (node: SceneNode, file: File) => {
    let replaced: { imageAssetId: string; previousImageAssetId: string } | null = null;
    execute({
      label: `replace image in “${node.name}”`,
      run: async () => {
        if (replaced) return pointImageAt(node.id, replaced.imageAssetId);
        const form = new FormData();
        form.append("file", file);
        const result = await api.upload<{ imageAssetId: string; previousImageAssetId: string }>(`${base}/nodes/${node.id}/image`, form);
        replaced = result;
        setSceneGraph((sg) => sg && withNodeUpdate(sg, node.id, { imageAssetId: result.imageAssetId }));
      },
      undo: () => pointImageAt(node.id, replaced!.previousImageAssetId),
    });
  };

  const imageDrop: ImageDrop = {
    rejectReason: (node) => {
      if (!node || !sceneGraph) return "Drop the image onto an image or smart object layer.";
      if (node.type !== "pixel" && node.type !== "smartObject") {
        return `“${node.name}” is a ${TYPE_LABEL[node.type]} layer; only Pixel and Smart Object layers take a dropped image.`;
      }
      const lock = [node.id, ...(ancestorIds(sceneGraph.root, node.id) ?? [])].map((id) => findNode(sceneGraph.root, id)).find((n) => n?.locked);
      return lock ? `“${lock.name}” is locked; unlock it in the Layers panel to replace this image.` : null;
    },
    onDrop: replaceImage,
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      const canvas = canvasRef.current;
      if (mod && key === "z") void (e.shiftKey ? commands.redo() : commands.undo());
      else if (mod && key === "y") void commands.redo();
      else if (key === "escape") {
        if (!canvas?.exitTextFocus()) setSelectedNodeId(null);
      } else if ((key === "delete" || key === "backspace") && existingField && !(e.target instanceof Element && e.target.closest("form"))) removeField(existingField);
      else if (!handleZoomKey(e, canvas)) return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Saving shows in the top bar; the canvas chip is only about the canvas itself.
  const layersLoading = layerImages.loaded < layerImages.total;
  const canvasStatus =
    layerImages.failed > 0 ? `${layerImages.failed} layer image(s) failed to load` : layersLoading ? `Loading layers ${layerImages.loaded}/${layerImages.total}…` : null;

  const publish = async () => {
    setError(null);
    setPublishing(true);
    try {
      const stepUpToken = await stepUp();
      await api.post(`${base}/publish`, {}, stepUpToken);
      navigate("/admin/templates");
    } catch (err) {
      setError(err instanceof ApiError ? (err.detail ?? err.title) : "Publish failed.");
    } finally {
      setPublishing(false);
    }
  };

  if (!template || !version) {
    if (!loadError) return <WorkspaceSkeleton label="Opening template" />;
    return (
      <StatePage title="Template">
        <EmptyState
          icon={<AlertCircle size={22} />}
          tone="danger"
          title="This template couldn't be opened"
          actions={
            <>
              <Link className="btn" to={BACK.to}>
                Back to library
              </Link>
              <button className="primary" onClick={() => void tryLoad()}>
                <RefreshCw size={15} aria-hidden="true" /> Try again
              </button>
            </>
          }
        >
          {loadError}
        </EmptyState>
      </StatePage>
    );
  }

  if (version.ingestStatus !== "READY") {
    const failed = version.ingestStatus === "FAILED";
    return (
      <StatePage title={template.name} meta={<span className="ws-chip">v{version.versionNo}</span>}>
        <EmptyState
          icon={failed ? <FileWarning size={22} /> : <Spinner size="lg" />}
          tone={failed ? "danger" : undefined}
          title={failed ? "This PSD couldn't be processed" : "Preparing your PSD"}
          actions={
            <>
              {failed && (
                <Link className="btn" to={BACK.to}>
                  Back to library
                </Link>
              )}
              <button className={failed ? "primary" : undefined} onClick={() => void tryLoad()}>
                <RefreshCw size={15} aria-hidden="true" /> Refresh
              </button>
            </>
          }
        >
          {failed
            ? "Upload a corrected file as a new version from the template library."
            : "Reading every layer, font and smart object. The workspace opens by itself as soon as it's ready."}
        </EmptyState>
        <ol className="ingest-steps" aria-label="Ingestion progress">
          <li className="done">
            <span className="dot">
              <Check size={13} strokeWidth={3} aria-hidden="true" />
            </span>
            PSD uploaded
          </li>
          <li className={failed ? "failed" : "active"}>
            <span className="dot">{failed ? <X size={13} strokeWidth={3} aria-hidden="true" /> : <Spinner />}</span>
            Parsing layers <span className={`badge ${version.ingestStatus}`}>{version.ingestStatus}</span>
          </li>
          <li>
            <span className="dot">
              <MousePointerClick size={12} aria-hidden="true" />
            </span>
            Map editable fields
          </li>
        </ol>
        {failed ? <div className="error-box">{version.ingestError ?? "Ingestion failed."}</div> : <div className="progress-bar" aria-hidden="true" />}
      </StatePage>
    );
  }

  const saving = publishing || commands.busy;
  const warnings = version.ingestWarnings ?? [];
  const sortedFields = [...fields].sort((a, b) => a.order - b.order);
  const bodyStyle = { "--left-w": `${leftPanel.collapsed ? 0 : leftPanel.width}px`, "--right-w": `${rightPanel.collapsed ? 0 : rightPanel.width}px` } as CSSProperties;

  return (
    <div className="ws workspace-page">
      <WorkspaceTopBar
        back={BACK}
        title={template.name}
        meta={
          <>
            <span className="ws-chip" title={`Template version ${version.versionNo}`}>
              v{version.versionNo}
            </span>
            <span className={`badge ${template.status} hide-sm`}>{template.status === "PUBLISHED" ? "Published" : template.status === "DRAFT" ? "Draft" : template.status}</span>
            {warnings.length > 0 && (
              <Popover
                align="start"
                trigger={(props) => (
                  <button type="button" className="ws-chip warn hide-sm" {...props} aria-label={`${warnings.length} ingestion warnings`}>
                    <AlertTriangle size={12} aria-hidden="true" />
                    {warnings.length}
                    <span className="hide-md">{warnings.length === 1 ? " warning" : " warnings"}</span>
                  </button>
                )}
              >
                <p className="popover-title">
                  <AlertTriangle size={14} color="var(--warning-500)" aria-hidden="true" /> Ingestion notes
                </p>
                <p className="hint">Fidelity notes from parsing this PSD, not errors.</p>
                <ul className="warning-list">
                  {warnings.map((w, i) => (
                    <li key={i}>
                      <span className="path">{w.path}</span>
                      {w.message}
                    </li>
                  ))}
                </ul>
              </Popover>
            )}
          </>
        }
        center={
          <div className="ws-toolgroup" role="toolbar" aria-label="History">
            <button
              type="button"
              className="icon-btn"
              aria-label="Undo"
              onClick={() => void commands.undo()}
              disabled={!commands.undoLabel || commands.busy}
              data-tip={commands.undoLabel ? `Undo ${commands.undoLabel}  ${MOD}Z` : "Nothing to undo"}
            >
              <Undo2 size={18} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="icon-btn"
              aria-label="Redo"
              onClick={() => void commands.redo()}
              disabled={!commands.redoLabel || commands.busy}
              data-tip={commands.redoLabel ? `Redo ${commands.redoLabel}  ⇧${MOD}Z` : "Nothing to redo"}
            >
              <Redo2 size={18} aria-hidden="true" />
            </button>
          </div>
        }
        end={
          <>
            {(commands.busy || saved) && (
              <span className={`save-pill hide-md ${commands.busy ? "saving" : "saved"}`} role="status" aria-label="Workspace save status">
                {commands.busy ? <Spinner /> : <Check size={14} strokeWidth={2.5} aria-hidden="true" />}
                {commands.busy ? "Saving…" : "Saved"}
              </span>
            )}
            <button type="button" className="icon-btn panel-toggle" aria-pressed={!leftPanel.collapsed} aria-label="Layers panel" data-tip={leftPanel.collapsed ? "Show layers" : "Hide layers"} onClick={leftPanel.toggle}>
              <PanelLeft size={18} aria-hidden="true" />
            </button>
            <button type="button" className="icon-btn panel-toggle" aria-pressed={!rightPanel.collapsed} aria-label="Fields panel" data-tip={rightPanel.collapsed ? "Show fields" : "Hide fields"} onClick={rightPanel.toggle}>
              <PanelRight size={18} aria-hidden="true" />
            </button>
            <ShortcutsButton shortcuts={SHORTCUTS} />
            <span className="ws-divider" aria-hidden="true" />
            <button
              className="primary"
              onClick={publish}
              disabled={saving || fields.length === 0}
              aria-label="Publish this version"
              data-tip={fields.length === 0 ? "Map at least one field first" : "Make this version available to end users"}
              data-tip-align="end"
            >
              {publishing ? <Spinner /> : <Rocket size={15} aria-hidden="true" />}
              Publish
            </button>
          </>
        }
      />

      <div className={`ws-body mapping-layout${leftPanel.collapsed ? " left-collapsed" : ""}${rightPanel.collapsed ? " right-collapsed" : ""}`} style={bodyStyle}>
        <aside className="panel left mapping-pane" aria-label="Layers panel">
          <div className="panel-inner" inert={leftPanel.collapsed}>
            <div className="panel-header">
              <h3 className="panel-title">
                Layers {sceneGraph && <span className="panel-count">{countNodes(sceneGraph.root)}</span>}
              </h3>
            </div>
            {sceneGraph && (
              <LayerTree
                nodes={sceneGraph.root}
                selectedId={selectedNodeId}
                mappedNodeIds={mappedNodeIds}
                onSelect={(n) => setSelectedNodeId(n.id)}
                isVisible={isVisible}
                onToggleVisible={toggleVisible}
                onToggleLocked={toggleLocked}
                images={layerImages.store}
              />
            )}
          </div>
          <PanelResizer side="left" width={leftPanel.width} min={200} max={420} onResize={leftPanel.setWidth} onReset={leftPanel.reset} label="Resize layers panel" />
        </aside>

        <main className="ws-canvas workspace-canvas-pane">
          {error && (
            <div className="error-box ws-canvas-banner" role="alert">
              <AlertCircle size={16} aria-hidden="true" />
              <span>{error}</span>
              <button type="button" className="icon-btn sm dismiss" aria-label="Dismiss" onClick={() => setError(null)}>
                <X size={15} aria-hidden="true" />
              </button>
            </div>
          )}
          {sceneGraph && (
            <SceneCanvas
              ref={canvasRef}
              graph={sceneGraph}
              images={layerImages.store}
              imagesVersion={layerImages.version}
              visibility={visibility}
              selectedId={selectedNodeId}
              onSelect={(n) => setSelectedNodeId(n.id)}
              isPickable={isPickable}
              status={canvasStatus}
              statusTone={layerImages.failed > 0 ? "error" : "busy"}
              loading={layersLoading}
              imageDrop={imageDrop}
              artboardLabel={template.name}
            />
          )}
        </main>

        <aside className="panel right mapping-pane" aria-label="Fields panel">
          <div className="panel-inner" inert={rightPanel.collapsed}>
            {selectedNode ? (
              <div className="panel-body">
                <FieldMappingForm
                  key={`${selectedNode.id}:${fieldsRevision}`}
                  node={selectedNode}
                  existingField={existingField}
                  onSave={saveField}
                  onDelete={() => existingField && removeField(existingField)}
                  onClose={() => setSelectedNodeId(null)}
                  saving={saving}
                />
              </div>
            ) : (
              <>
                <div className="panel-header">
                  <h3 className="panel-title">
                    Mapped fields <span className="panel-count">{fields.length}</span>
                  </h3>
                </div>
                <div className="panel-body">
                  {sortedFields.length === 0 ? (
                    <EmptyState icon={<MousePointerClick size={20} />} title="No fields mapped yet">
                      Select a layer on the canvas or in the Layers panel to make it editable for end users.
                    </EmptyState>
                  ) : (
                    <ul className="field-list">
                      {sortedFields.map((f) => {
                        const Icon = FIELD_ICON[f.fieldType];
                        return (
                          <li key={f.id}>
                            <button type="button" onClick={() => setSelectedNodeId(f.nodeId)} aria-label={`Edit field ${f.label}`}>
                              <span className="f-icon">
                                <Icon size={15} aria-hidden="true" />
                              </span>
                              <span className="f-text">
                                <span className="f-label">{f.label}</span>
                                <span className="f-kind">{FIELD_TYPE_LABEL[f.fieldType]}</span>
                              </span>
                              <ChevronRight size={16} className="f-go" aria-hidden="true" />
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
                <div className="panel-footer editor-tip">
                  <MousePointerClick size={14} aria-hidden="true" />
                  <span>Click any layer to map it. Double-click text to inspect its runs; drop an image on a pixel or smart object layer to replace it.</span>
                </div>
              </>
            )}
          </div>
          <PanelResizer side="right" width={rightPanel.width} min={248} max={460} onResize={rightPanel.setWidth} onReset={rightPanel.reset} label="Resize fields panel" />
        </aside>
      </div>
    </div>
  );
}

/** A workspace frame (top bar + dark canvas surround) holding one centered card: ingest progress, load failures. */
function StatePage({ title, meta, children }: { title: string; meta?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="ws">
      <WorkspaceTopBar back={BACK} title={title} meta={meta} />
      <div className="ws-state">
        <div className="ws-state-card">{children}</div>
      </div>
    </div>
  );
}
