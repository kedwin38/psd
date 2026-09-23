import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import type { SceneGraph, SceneNode } from "@psd-studio/scene-graph";
import { api, ApiError } from "../lib/api";
import { stepUp } from "../lib/auth-api";
import type { Template, TemplateField, TemplateVersion } from "../lib/types";
import { LayerTree } from "./LayerTree";
import { FieldMappingForm } from "./FieldMappingForm";

function findNode(nodes: SceneNode[], id: string): SceneNode | null {
  for (const n of nodes) {
    if (n.id === id) return n;
    if (n.type === "group") {
      const found = findNode(n.children, id);
      if (found) return found;
    }
  }
  return null;
}

export function TemplateWorkspacePage() {
  const { templateId, versionId } = useParams<{ templateId: string; versionId: string }>();
  const navigate = useNavigate();

  const [template, setTemplate] = useState<Template | null>(null);
  const [version, setVersion] = useState<TemplateVersion | null>(null);
  const [sceneGraph, setSceneGraph] = useState<SceneGraph | null>(null);
  const [fields, setFields] = useState<TemplateField[]>([]);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    if (!templateId || !versionId) return;
    const [t, v, f] = await Promise.all([
      api.get<Template>(`/templates/${templateId}`),
      api.get<TemplateVersion>(`/templates/${templateId}/versions/${versionId}`),
      api.get<TemplateField[]>(`/templates/${templateId}/versions/${versionId}/fields`),
    ]);
    setTemplate(t);
    setVersion(v);
    setFields(f);
    if (v.ingestStatus === "READY") {
      const [sg, preview] = await Promise.all([
        api.get<SceneGraph>(`/templates/${templateId}/versions/${versionId}/scene-graph`),
        api.get<{ dataUrl: string }>(`/templates/${templateId}/versions/${versionId}/preview`),
      ]);
      setSceneGraph(sg);
      setPreviewUrl(preview.dataUrl);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templateId, versionId]);

  const mappedNodeIds = useMemo(() => new Set(fields.map((f) => f.nodeId)), [fields]);
  const selectedNode = sceneGraph && selectedNodeId ? findNode(sceneGraph.root, selectedNodeId) : null;
  const existingField = fields.find((f) => f.nodeId === selectedNodeId);

  const saveField = async (fieldType: string, label: string, constraints: Record<string, unknown>) => {
    if (!selectedNode) return;
    setSaving(true);
    setError(null);
    try {
      if (existingField) {
        await api.patch(`/templates/${templateId}/versions/${versionId}/fields/${existingField.id}`, { fieldType, label, constraints });
      } else {
        await api.post(`/templates/${templateId}/versions/${versionId}/fields`, {
          nodeId: selectedNode.id,
          layerPath: selectedNode.path,
          fieldType,
          label,
          order: fields.length,
          constraints,
        });
      }
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? (err.detail ?? (err.errors ?? []).join("; ") ?? err.title) : "Could not save field.");
    } finally {
      setSaving(false);
    }
  };

  const deleteField = async () => {
    if (!existingField) return;
    setSaving(true);
    try {
      await api.del(`/templates/${templateId}/versions/${versionId}/fields/${existingField.id}`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? (err.detail ?? err.title) : "Could not remove field.");
    } finally {
      setSaving(false);
    }
  };

  const publish = async () => {
    setError(null);
    setSaving(true);
    try {
      const stepUpToken = await stepUp();
      await api.post(`/templates/${templateId}/versions/${versionId}/publish`, {}, stepUpToken);
      navigate("/admin/templates");
    } catch (err) {
      setError(err instanceof ApiError ? (err.detail ?? err.title) : "Publish failed.");
    } finally {
      setSaving(false);
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
        <button className="primary" onClick={publish} disabled={saving || fields.length === 0}>
          Publish this version
        </button>
      </div>
      {error && <div className="error-box">{error}</div>}

      <div className="mapping-layout">
        <div className="mapping-pane">
          <h3>Layers</h3>
          {sceneGraph && (
            <LayerTree nodes={sceneGraph.root} selectedId={selectedNodeId} mappedNodeIds={mappedNodeIds} onSelect={(n) => setSelectedNodeId(n.id)} />
          )}
        </div>

        <div className="editor-canvas-pane">{previewUrl && <img src={previewUrl} alt="Template preview" />}</div>

        <div className="mapping-pane">
          {selectedNode ? (
            <FieldMappingForm key={selectedNode.id} node={selectedNode} existingField={existingField} onSave={saveField} onDelete={deleteField} saving={saving} />
          ) : (
            <>
              <h3>Mapped fields ({fields.length})</h3>
              <p className="hint">Click a layer on the left to tag it as an editable field.</p>
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
            </>
          )}
        </div>
      </div>
    </div>
  );
}
