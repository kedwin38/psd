import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import type { SceneGraph } from "@psd-studio/scene-graph";
import { api, ApiError } from "../lib/api";
import type { ExportJob, Project, TemplateField } from "../lib/types";

type FieldValue =
  | { type: "text"; text: string }
  | { type: "image"; imageAssetId: string; crop: { x: number; y: number; width: number; height: number }; previewName?: string }
  | { type: "visibility"; visible: boolean };

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export function ProjectEditorPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [project, setProject] = useState<Project | null>(null);
  const [fields, setFields] = useState<TemplateField[]>([]);
  const [values, setValues] = useState<Record<string, FieldValue>>({});
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exportFormat, setExportFormat] = useState<ExportJob["outputFormat"]>("PNG");
  const [exportJob, setExportJob] = useState<ExportJob | null>(null);
  const [exporting, setExporting] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = async () => {
    if (!projectId) return;
    const p = await api.get<Project>(`/projects/${projectId}`);
    setProject(p);
    const [, sceneGraphResolved] = await Promise.all([
      Promise.resolve(),
      api.get<SceneGraph>(`/templates/${p.templateId}/versions/${p.templateVersionId}/scene-graph`),
    ]);
    void sceneGraphResolved;
    const f = await api.get<TemplateField[]>(`/templates/${p.templateId}/versions/${p.templateVersionId}/fields`);
    setFields(f);

    const initialValues: Record<string, FieldValue> = {};
    for (const fv of p.fieldValues ?? []) {
      initialValues[fv.templateFieldId] = fv.value as FieldValue;
    }
    setValues(initialValues);
    await refreshPreview();
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const refreshPreview = useCallback(async () => {
    if (!projectId) return;
    setPreviewing(true);
    try {
      const result = await api.post<{ dataUrl: string }>(`/projects/${projectId}/preview`);
      setPreviewUrl(result.dataUrl);
    } finally {
      setPreviewing(false);
    }
  }, [projectId]);

  const schedulePreview = () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(refreshPreview, 400);
  };

  const patchField = async (fieldId: string, value: FieldValue) => {
    if (!projectId) return;
    setValues((prev) => ({ ...prev, [fieldId]: value }));
    setError(null);
    try {
      await api.put(`/projects/${projectId}/fields/${fieldId}`, value);
      schedulePreview();
    } catch (err) {
      setError(err instanceof ApiError ? (err.detail ?? err.title) : "Could not save this field.");
    }
  };

  const uploadImage = async (field: TemplateField, file: File) => {
    if (!projectId) return;
    setError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("fieldId", field.id);
      const result = await api.upload<{ assetId: string }>(`/projects/${projectId}/uploads`, form);
      await patchField(field.id, { type: "image", imageAssetId: result.assetId, crop: { x: 0, y: 0, width: 1, height: 1 }, previewName: file.name });
    } catch (err) {
      setError(err instanceof ApiError ? (err.detail ?? err.title) : "Upload failed — check the field's size/type requirements.");
    }
  };

  const requestExport = async () => {
    if (!projectId) return;
    setExporting(true);
    setError(null);
    try {
      let job = await api.post<ExportJob>("/exports", { projectId, format: exportFormat, dpiScale: 1 });
      setExportJob(job);
      for (let i = 0; i < 40 && job.status !== "COMPLETE" && job.status !== "FAILED"; i++) {
        await sleep(500);
        job = await api.get<ExportJob>(`/exports/${job.id}`);
        setExportJob(job);
      }
      if (job.status === "FAILED") setError(job.error ?? "Export failed.");
    } catch (err) {
      setError(err instanceof ApiError ? (err.detail ?? err.title) : "Could not start export.");
    } finally {
      setExporting(false);
    }
  };

  if (!project) return <p>Loading…</p>;

  return (
    <div className="editor-layout">
      <div className="editor-fields">
        <h1>{project.name}</h1>
        {error && <div className="error-box">{error}</div>}
        {fields
          .slice()
          .sort((a, b) => a.order - b.order)
          .map((field) => {
            const value = values[field.id];
            return (
              <div className="field-block" key={field.id}>
                <label>{field.label}</label>
                {field.fieldType === "TEXT" && (
                  <textarea
                    rows={2}
                    value={value?.type === "text" ? value.text : ""}
                    maxLength={(field.constraints.maxLength as number) ?? undefined}
                    onChange={(e) => patchField(field.id, { type: "text", text: e.target.value })}
                  />
                )}
                {(field.fieldType === "IMAGE" || field.fieldType === "SMART_OBJECT") && (
                  <div className="stack">
                    <input
                      type="file"
                      accept={(field.constraints.allowedMimeTypes as string[])?.join(",")}
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) uploadImage(field, file);
                      }}
                    />
                    {value?.type === "image" && <p className="hint">Uploaded: {value.previewName ?? value.imageAssetId.slice(0, 8)}</p>}
                    <p className="hint">
                      Min {String(field.constraints.minWidthPx)}×{String(field.constraints.minHeightPx)}px, aspect{" "}
                      {String(field.constraints.aspectRatioW)}:{String(field.constraints.aspectRatioH)}
                    </p>
                  </div>
                )}
                {field.fieldType === "VISIBILITY" && (
                  <label className="row">
                    <input
                      type="checkbox"
                      checked={value?.type === "visibility" ? value.visible : Boolean(field.constraints.defaultVisible)}
                      onChange={(e) => patchField(field.id, { type: "visibility", visible: e.target.checked })}
                    />
                    Show
                  </label>
                )}
              </div>
            );
          })}
        {fields.length === 0 && <p className="hint">This template has no editable fields.</p>}

        <div className="field-block">
          <h3>Export</h3>
          <div className="row">
            <select value={exportFormat} onChange={(e) => setExportFormat(e.target.value as ExportJob["outputFormat"])}>
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
        {previewUrl ? <img src={previewUrl} alt="Live preview" /> : <p className="hint">Rendering preview…</p>}
        {previewing && <p className="hint" style={{ position: "absolute", marginTop: 260 }}>Updating…</p>}
      </div>
    </div>
  );
}
