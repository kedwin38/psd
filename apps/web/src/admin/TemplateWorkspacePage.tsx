import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import type { SceneGraph, SceneNode } from "@psd-studio/scene-graph";
import { api, ApiError } from "../lib/api";
import { stepUp } from "../lib/auth-api";
import { isTypingTarget } from "../lib/keyboard";
import type { FieldType, Template, TemplateField, TemplateVersion } from "../lib/types";
import { SceneCanvas, handleZoomKey, type ImageDrop, type SceneCanvasHandle } from "../canvas/SceneCanvas";
import { ancestorIds, findNode, withNodeUpdate } from "../canvas/sceneTree";
import { useLayerImages } from "../canvas/useLayerImages";
import { LayerTree, TYPE_LABEL } from "./LayerTree";
import { FieldMappingForm } from "./FieldMappingForm";
import { useCommandStack, type Command } from "./useCommandStack";

const isPickable = (node: SceneNode) => !node.locked;

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
  const [publishing, setPublishing] = useState(false);
  const canvasRef = useRef<SceneCanvasHandle>(null);
  const commands = useCommandStack((err) => setError(errorMessage(err)));

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

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templateId, versionId]);

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

  const canvasStatus =
    layerImages.failed > 0
      ? `${layerImages.failed} layer image(s) failed to load`
      : layerImages.loaded < layerImages.total
        ? `Loading layers ${layerImages.loaded}/${layerImages.total}…`
        : commands.busy
          ? "Saving…"
          : null;

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

  if (!template || !version) return <p>Loading…</p>;

  if (version.ingestStatus !== "READY") {
    return (
      <div className="card" style={{ maxWidth: 480 }}>
        <h2>
          {template.name} — version #{version.versionNo}
        </h2>
        <p>
          Ingestion status: <span className={`badge ${version.ingestStatus}`}>{version.ingestStatus}</span>
        </p>
        {version.ingestStatus === "FAILED" && <div className="error-box">{version.ingestError}</div>}
        {(version.ingestStatus === "PENDING" || version.ingestStatus === "PARSING") && (
          <p className="hint">Parsing the PSD in the background — this page will update automatically.</p>
        )}
        <button onClick={load}>Refresh</button>
      </div>
    );
  }

  const saving = publishing || commands.busy;

  return (
    <div>
      <div className="row between" style={{ marginBottom: 16 }}>
        <div>
          <h1>
            {template.name} <span className="hint">v{version.versionNo}</span>
          </h1>
          {version.ingestWarnings && version.ingestWarnings.length > 0 && (
            <p className="hint">{version.ingestWarnings.length} ingestion warning(s) — fidelity notes, not errors.</p>
          )}
        </div>
        <div className="row">
          <button onClick={() => void commands.undo()} disabled={!commands.undoLabel || commands.busy} title={commands.undoLabel ? `Undo ${commands.undoLabel} (Ctrl/⌘+Z)` : "Nothing to undo"}>
            Undo
          </button>
          <button onClick={() => void commands.redo()} disabled={!commands.redoLabel || commands.busy} title={commands.redoLabel ? `Redo ${commands.redoLabel} (Ctrl/⌘+Shift+Z)` : "Nothing to redo"}>
            Redo
          </button>
          <button className="primary" onClick={publish} disabled={saving || fields.length === 0}>
            Publish this version
          </button>
        </div>
      </div>
      {error && <div className="error-box">{error}</div>}

      <div className="mapping-layout">
        <div className="mapping-pane">
          <h3>Layers</h3>
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

        <div className="workspace-canvas-pane">
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
              imageDrop={imageDrop}
            />
          )}
        </div>

        <div className="mapping-pane">
          {selectedNode ? (
            <FieldMappingForm
              key={`${selectedNode.id}:${fieldsRevision}`}
              node={selectedNode}
              existingField={existingField}
              onSave={saveField}
              onDelete={() => existingField && removeField(existingField)}
              saving={saving}
            />
          ) : (
            <>
              <h3>Mapped fields ({fields.length})</h3>
              <p className="hint">Click a layer on the left or on the canvas to tag it as an editable field.</p>
              <div className="stack">
                {fields.map((f) => (
                  <div key={f.id} className="row between" style={{ fontSize: 13 }}>
                    <span>
                      {f.label} <span className="hint">({f.fieldType})</span>
                    </span>
                    <button className="link" onClick={() => setSelectedNodeId(f.nodeId)}>
                      Edit
                    </button>
                  </div>
                ))}
              </div>
              <p className="hint" style={{ marginTop: 16 }}>
                Canvas: scroll or pinch to zoom, Space+drag to pan, double-click text to inspect its runs, drop an image onto an image layer to
                replace it. Ctrl/⌘+Z undoes, Esc deselects, Delete removes the selected layer's field.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
