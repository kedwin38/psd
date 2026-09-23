import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, ApiError } from "../lib/api";
import type { Category, Template } from "../lib/types";

interface AdminTemplate extends Template {
  versions: { id: string; versionNo: number; ingestStatus: string }[];
}

export function TemplatesAdminPage() {
  const [templates, setTemplates] = useState<AdminTemplate[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [name, setName] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
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

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api.post("/templates", { name, categoryId, visibilityScope: "PUBLIC" });
      setName("");
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? (err.detail ?? err.title) : "Could not create template.");
    } finally {
      setBusy(false);
    }
  };

  const uploadVersion = async (templateId: string) => {
    const input = fileInputs.current[templateId];
    const file = input?.files?.[0];
    if (!file) return;
    setError(null);
    setBusy(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const version = await api.upload<{ id: string }>(`/templates/${templateId}/versions`, form);
      navigate(`/admin/templates/${templateId}/versions/${version.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? (err.detail ?? err.title) : "Upload failed.");
    } finally {
      setBusy(false);
      if (input) input.value = "";
    }
  };

  return (
    <div className="grid-2">
      <div>
        <h1>Template library</h1>
        <p className="subtitle">Upload a PSD, map its fields, and publish (spec §10).</p>
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
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {t.versions.map((v) => (
                      <tr key={v.id}>
                        <td>
                          #{v.versionNo} {t.currentVersionId === v.id && <span className="badge PUBLISHED">current</span>}
                        </td>
                        <td>
                          <span className={`badge ${v.ingestStatus}`}>{v.ingestStatus}</span>
                        </td>
                        <td>
                          <button className="link" onClick={() => navigate(`/admin/templates/${t.id}/versions/${v.id}`)}>
                            {v.ingestStatus === "READY" ? "Map fields →" : "View →"}
                          </button>
                        </td>
                      </tr>
                    ))}
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
          {categories.length === 0 && <p className="hint">Create a category first.</p>}
        </form>
      </div>
    </div>
  );
}
