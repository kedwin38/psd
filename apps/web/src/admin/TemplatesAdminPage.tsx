import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Rocket } from "lucide-react";
import { api, ApiError } from "../lib/api";
import { stepUp } from "../lib/auth-api";
import type { Category, Template, TemplateVersion } from "../lib/types";
import { Spinner } from "../components/workspace";

const INGEST_POLL_MS = 2000;

interface AdminTemplate extends Template {
  versions: (Pick<TemplateVersion, "id" | "versionNo" | "ingestStatus" | "publishedAt"> & { _count: { fields: number } })[];
}

const errorText = (err: unknown, fallback: string) => (err instanceof ApiError ? (err.detail ?? err.title) : fallback);

function UploadProgress({ fraction }: { fraction: number }) {
  const percent = Math.round(fraction * 100);
  return (
    <div className="upload-progress">
      <progress value={percent} max={100} aria-label="Uploading PSD" />
      <span aria-hidden="true">{percent}%</span>
    </div>
  );
}

export function TemplatesAdminPage() {
  const [templates, setTemplates] = useState<AdminTemplate[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [name, setName] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [psd, setPsd] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [publishing, setPublishing] = useState<string | null>(null);
  // Where the progress shows: "new" for the new-template form, else the id of the template getting a new version.
  const [uploading, setUploading] = useState<{ target: string; fraction: number } | null>(null);
  const psdInput = useRef<HTMLInputElement>(null);
  const fileInputs = useRef<Record<string, HTMLInputElement | null>>({});
  const navigate = useNavigate();

  const load = async () => {
    const [t, c] = await Promise.all([api.get<AdminTemplate[]>("/templates/admin/all"), api.get<Category[]>("/categories")]);
    setTemplates(t);
    setCategories(c);
  };

  useEffect(() => {
    load();
  }, []);

  // PSDs parse in the background: keep checking until every upload is ready (or has failed).
  const ingesting = templates.some((t) => t.versions.some((v) => v.ingestStatus === "PENDING" || v.ingestStatus === "PARSING"));
  useEffect(() => {
    if (!ingesting) return;
    const timer = setInterval(() => void load(), INGEST_POLL_MS);
    return () => clearInterval(timer);
  }, [ingesting]);

  const upload = async (target: string, templateId: string, file: File) => {
    const form = new FormData();
    form.append("file", file);
    setUploading({ target, fraction: 0 });
    try {
      await api.upload(`/templates/${templateId}/versions`, form, (fraction) => setUploading({ target, fraction }));
    } finally {
      setUploading(null);
    }
  };

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!psd) return;
    setError(null);
    setBusy(true);
    try {
      const template = await api.post<Template>("/templates", { name, categoryId, visibilityScope: "PUBLIC" });
      setName("");
      setPsd(null);
      if (psdInput.current) psdInput.current.value = "";
      await upload("new", template.id, psd);
    } catch (err) {
      setError(errorText(err, "Could not create template."));
    } finally {
      setBusy(false);
      await load();
    }
  };

  const uploadVersion = async (templateId: string) => {
    const input = fileInputs.current[templateId];
    const file = input?.files?.[0];
    if (!file) return;
    setError(null);
    setBusy(true);
    try {
      await upload(templateId, templateId, file);
      await load();
    } catch (err) {
      setError(errorText(err, "Upload failed."));
    } finally {
      setBusy(false);
      if (input) input.value = "";
    }
  };

  const publish = async (templateId: string, versionId: string) => {
    setError(null);
    setPublishing(versionId);
    try {
      const stepUpToken = await stepUp();
      await api.post(`/templates/${templateId}/versions/${versionId}/publish`, {}, stepUpToken);
      await load();
    } catch (err) {
      setError(errorText(err, "Publish failed."));
    } finally {
      setPublishing(null);
    }
  };

  return (
    <div className="grid-2">
      <div>
        <h1>Template library</h1>
        <p className="subtitle">Upload a PSD and publish it: every unlocked layer becomes an editable field. Lock layers in the workspace to keep them fixed.</p>
        {error && <div className="error-box">{error}</div>}
        <div className="stack">
          {templates.map((t) => (
            <div className="card" key={t.id}>
              <div className="row between">
                <div>
                  <h3>
                    {t.name} <span className={`badge ${t.status}`}>{t.status}</span>
                  </h3>
                  <p className="hint">{categories.find((c) => c.id === t.categoryId)?.name ?? "Uncategorized"}</p>
                </div>
                <div className="row">
                  {uploading?.target === t.id && <UploadProgress fraction={uploading.fraction} />}
                  <input
                    type="file"
                    accept=".psd,.psb"
                    ref={(el) => {
                      fileInputs.current[t.id] = el;
                    }}
                    onChange={() => uploadVersion(t.id)}
                    style={{ display: "none" }}
                    id={`upload-${t.id}`}
                  />
                  <button disabled={busy} onClick={() => document.getElementById(`upload-${t.id}`)?.click()}>
                    Upload new PSD version
                  </button>
                </div>
              </div>
              {t.versions.length > 0 && (
                <table style={{ marginTop: 10 }}>
                  <thead>
                    <tr>
                      <th>Version</th>
                      <th>Ingestion</th>
                      <th>Editable fields</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {t.versions.map((v) => {
                      const ready = v.ingestStatus === "READY";
                      const live = t.status === "PUBLISHED" && t.currentVersionId === v.id;
                      return (
                        <tr key={v.id}>
                          <td>
                            #{v.versionNo} {live && <span className="badge PUBLISHED">current</span>}
                          </td>
                          <td>
                            <span className={`badge ${v.ingestStatus}`}>{v.ingestStatus}</span>
                          </td>
                          <td>{ready ? v._count.fields : "—"}</td>
                          <td>
                            <div className="row">
                              {ready && !live && (
                                <button
                                  className="primary sm"
                                  onClick={() => publish(t.id, v.id)}
                                  disabled={publishing !== null}
                                  aria-label={`Publish ${t.name} version ${v.versionNo}`}
                                  title="Every unlocked layer becomes an editable field"
                                >
                                  {publishing === v.id ? <Spinner /> : <Rocket size={14} aria-hidden="true" />}
                                  Publish
                                </button>
                              )}
                              {!ready && v.ingestStatus !== "FAILED" && <Spinner label="Processing PSD" />}
                              <button className="link" onClick={() => navigate(`/admin/templates/${t.id}/versions/${v.id}`)}>
                                {ready ? "Customize fields →" : "View →"}
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          ))}
          {templates.length === 0 && <p className="hint">No templates yet.</p>}
        </div>
      </div>
      <div className="card" style={{ height: "fit-content" }}>
        <h2>New template</h2>
        <form onSubmit={create} className="stack">
          <div>
            <label htmlFor="template-psd">PSD file</label>
            <input id="template-psd" ref={psdInput} type="file" accept=".psd,.psb" onChange={(e) => setPsd(e.target.files?.[0] ?? null)} required />
          </div>
          <div>
            <label htmlFor="template-name">Name</label>
            <input id="template-name" value={name} onChange={(e) => setName(e.target.value)} required />
          </div>
          <div>
            <label htmlFor="template-category">Category</label>
            <select id="template-category" value={categoryId} onChange={(e) => setCategoryId(e.target.value)} required>
              <option value="">Select a category…</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <button type="submit" className="primary" disabled={busy || categories.length === 0}>
            Create template
          </button>
          {uploading?.target === "new" && <UploadProgress fraction={uploading.fraction} />}
          {categories.length === 0 ? (
            <p className="hint">Create a category first.</p>
          ) : (
            <p className="hint">Publish it from the library as soon as it's processed, or customize its fields first.</p>
          )}
        </form>
      </div>
    </div>
  );
}
