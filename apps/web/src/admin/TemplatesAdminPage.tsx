import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Rocket } from "lucide-react";
import { api, ApiError } from "../lib/api";
import type { Category, Template, TemplateVersion } from "../lib/types";
import { categoryLabel, categoryTree, flattenTree } from "../lib/categories";
import { Spinner } from "../components/workspace";
import { useStepUp } from "../components/StepUpDialog";
import { TemplateThumbnail } from "../components/TemplateThumbnail";

const INGEST_POLL_MS = 2000;

interface AdminTemplate extends Template {
  versions: (Pick<TemplateVersion, "id" | "versionNo" | "ingestStatus" | "publishedAt"> & { _count: { fields: number } })[];
}

const errorText = (err: unknown, fallback: string) => (err instanceof ApiError ? (err.detail ?? err.title) : fallback);

function CategorySelect({ id, categories, value, onChange }: { id: string; categories: Category[]; value: string; onChange: (categoryId: string) => void }) {
  return (
    <select id={id} value={value} onChange={(e) => onChange(e.target.value)} required>
      <option value="">Select a category…</option>
      {flattenTree(categoryTree(categories)).map(({ category }) => (
        <option key={category.id} value={category.id}>
          {categoryLabel(categories, category.id)}
        </option>
      ))}
    </select>
  );
}

function UploadProgress({ fraction }: { fraction: number }) {
  const percent = Math.round(fraction * 100);
  return (
    <div className="upload-progress">
      <progress value={percent} max={100} aria-label="Uploading PSD" />
      <span aria-hidden="true">{percent}%</span>
    </div>
  );
}

interface BulkUploadResult {
  filename: string;
  templateId?: string;
  versionId?: string;
  error?: string;
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
  const [editing, setEditing] = useState<{ id: string; name: string; categoryId: string } | null>(null);
  // Where the progress shows: "new" for the new-template form, else the id of the template getting a new version.
  const [uploading, setUploading] = useState<{ target: string; fraction: number } | null>(null);
  const psdInput = useRef<HTMLInputElement>(null);
  const fileInputs = useRef<Record<string, HTMLInputElement | null>>({});
  const navigate = useNavigate();
  const { stepUp, dialog: stepUpDialog } = useStepUp();

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [bulkPublishing, setBulkPublishing] = useState(false);
  const [bulkFiles, setBulkFiles] = useState<File[]>([]);
  const [bulkCategoryId, setBulkCategoryId] = useState("");
  const [bulkUploading, setBulkUploading] = useState(false);
  const [bulkResults, setBulkResults] = useState<BulkUploadResult[] | null>(null);
  const bulkFileInput = useRef<HTMLInputElement>(null);
  const [uploadMode, setUploadMode] = useState<"single" | "bulk">("single");

  // Grouped by category, in the same order the category tree itself is defined (each category
  // right after its parent), so the library reads the same way the category picker does. A
  // template whose category no longer exists (deleted out from under it) falls into its own
  // trailing "Uncategorized" bucket rather than disappearing.
  const orderedCategories = useMemo(() => flattenTree(categoryTree(categories)), [categories]);
  const templatesByCategory = useMemo(() => {
    const map = new Map<string, AdminTemplate[]>();
    for (const t of templates) {
      const list = map.get(t.categoryId);
      if (list) list.push(t);
      else map.set(t.categoryId, [t]);
    }
    return map;
  }, [templates]);
  const knownCategoryIds = new Set(categories.map((c) => c.id));
  const uncategorizedTemplates = templates.filter((t) => !knownCategoryIds.has(t.categoryId));

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
      await api.upload(`/templates/${templateId}/versions`, form, undefined, (fraction) => setUploading({ target, fraction }));
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

  const [removingVersion, setRemovingVersion] = useState<string | null>(null);

  const removeVersion = async (template: AdminTemplate, version: AdminTemplate["versions"][number]) => {
    if (!confirm(`Delete version #${version.versionNo} of “${template.name}”? This can't be undone.`)) return;
    setError(null);
    setRemovingVersion(version.id);
    try {
      const stepUpToken = await stepUp();
      if (!stepUpToken) return;
      await api.del(`/templates/${template.id}/versions/${version.id}`, stepUpToken);
      await load();
    } catch (err) {
      setError(errorText(err, "Could not delete this version."));
    } finally {
      setRemovingVersion(null);
    }
  };

  const publish = async (templateId: string, versionId: string) => {
    setError(null);
    setPublishing(versionId);
    try {
      const stepUpToken = await stepUp();
      if (!stepUpToken) return;
      await api.post(`/templates/${templateId}/versions/${versionId}/publish`, {}, stepUpToken);
      await load();
    } catch (err) {
      setError(errorText(err, "Publish failed."));
    } finally {
      setPublishing(null);
    }
  };

  const saveDetails = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    const { id, ...details } = editing;
    setError(null);
    setBusy(true);
    try {
      await api.patch(`/templates/${id}`, details);
      setEditing(null);
      await load();
    } catch (err) {
      setError(errorText(err, "Could not save the template."));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (template: AdminTemplate) => {
    if (!confirm(`Delete “${template.name}”? It leaves the catalog at once. Projects end users already started from it keep working.`)) return;
    setError(null);
    setBusy(true);
    try {
      const stepUpToken = await stepUp();
      if (!stepUpToken) return;
      await api.del(`/templates/${template.id}`, stepUpToken);
      await load();
    } catch (err) {
      setError(errorText(err, "Could not delete the template."));
    } finally {
      setBusy(false);
    }
  };

  const toggleSelected = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    setSelected((prev) => (prev.size === templates.length ? new Set() : new Set(templates.map((t) => t.id))));
  };

  const toggleSelectGroup = (group: AdminTemplate[]) => {
    const groupIds = group.map((t) => t.id);
    const allSelected = groupIds.every((id) => selected.has(id));
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of groupIds) (allSelected ? next.delete(id) : next.add(id));
      return next;
    });
  };

  const bulkRemove = async () => {
    if (selected.size === 0) return;
    if (!confirm(`Delete ${selected.size} template(s)? This can't be undone. Templates any project already used stay in the catalog as removed but keep working for those projects.`)) return;
    setError(null);
    setBulkDeleting(true);
    try {
      const stepUpToken = await stepUp();
      if (!stepUpToken) return;
      const results = await api.post<{ id: string; ok: boolean; error?: string }[]>("/templates/bulk-delete", { ids: Array.from(selected) }, stepUpToken);
      const failed = results.filter((r) => !r.ok);
      if (failed.length > 0) setError(`${failed.length} of ${results.length} could not be deleted: ${failed.map((f) => f.error).join("; ")}`);
      setSelected(new Set());
      await load();
    } catch (err) {
      setError(errorText(err, "Bulk delete failed."));
    } finally {
      setBulkDeleting(false);
    }
  };

  const bulkPublish = async () => {
    if (selected.size === 0) return;
    if (!confirm(`Publish ${selected.size} template(s)? Each publishes its own latest successfully-processed version — end users see it immediately.`)) return;
    setError(null);
    setBulkPublishing(true);
    try {
      const stepUpToken = await stepUp();
      if (!stepUpToken) return;
      const results = await api.post<{ id: string; ok: boolean; alreadyPublished?: boolean; error?: string }[]>("/templates/bulk-publish", { ids: Array.from(selected) }, stepUpToken);
      const failed = results.filter((r) => !r.ok);
      if (failed.length > 0) setError(`${failed.length} of ${results.length} could not be published: ${failed.map((f) => f.error).join("; ")}`);
      setSelected(new Set());
      await load();
    } catch (err) {
      setError(errorText(err, "Bulk publish failed."));
    } finally {
      setBulkPublishing(false);
    }
  };

  const bulkUpload = async (e: React.FormEvent) => {
    e.preventDefault();
    if (bulkFiles.length === 0 || !bulkCategoryId) return;
    setError(null);
    setBulkResults(null);
    setBulkUploading(true);
    try {
      const form = new FormData();
      for (const file of bulkFiles) form.append("files", file);
      form.append("categoryId", bulkCategoryId);
      form.append("visibilityScope", "PUBLIC");
      const results = await api.upload<BulkUploadResult[]>("/templates/bulk-upload", form);
      setBulkResults(results);
      setBulkFiles([]);
      if (bulkFileInput.current) bulkFileInput.current.value = "";
      await load();
    } catch (err) {
      setError(errorText(err, "Bulk upload failed."));
    } finally {
      setBulkUploading(false);
    }
  };

  const renderTemplateCard = (t: AdminTemplate) => (
    <div className="card" key={t.id}>
      <div className="row between admin-template-head">
        <div className="row">
          <input type="checkbox" checked={selected.has(t.id)} onChange={() => toggleSelected(t.id)} aria-label={`Select ${t.name}`} style={{ marginRight: 4 }} />
          <TemplateThumbnail template={t} className="small" />
          {editing?.id === t.id ? (
            <form onSubmit={saveDetails} className="template-details-form">
              <div>
                <label htmlFor="template-rename">Template name</label>
                <input id="template-rename" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} required autoFocus />
              </div>
              <div>
                <label htmlFor="template-move">Category</label>
                <CategorySelect id="template-move" categories={categories} value={editing.categoryId} onChange={(categoryId) => setEditing({ ...editing, categoryId })} />
              </div>
              <div className="row">
                <button type="submit" className="primary sm" disabled={busy}>
                  Save
                </button>
                <button type="button" className="sm" onClick={() => setEditing(null)}>
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <div>
              <h3>
                {t.name} <span className={`badge ${t.status}`}>{t.status}</span>
              </h3>
              <p className="hint">{categoryLabel(categories, t.categoryId) || "Uncategorized"}</p>
            </div>
          )}
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
          <button
            disabled={busy}
            onClick={() => document.getElementById(`upload-${t.id}`)?.click()}
            title="Upload a new PSD for this template. End users get it once you publish it."
          >
            Replace PSD…
          </button>
          {editing?.id !== t.id && (
            <button disabled={busy} onClick={() => setEditing({ id: t.id, name: t.name, categoryId: t.categoryId })}>
              Edit
            </button>
          )}
          <button className="danger" disabled={busy} onClick={() => remove(t)}>
            Delete
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
                      {!live && (
                        <button
                          type="button"
                          className="sm danger ghost"
                          disabled={removingVersion !== null}
                          aria-label={`Delete ${t.name} version ${v.versionNo}`}
                          title="Delete this version"
                          onClick={() => removeVersion(t, v)}
                        >
                          {removingVersion === v.id ? <Spinner /> : "Delete"}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );

  const renderCategorySection = (key: string, title: string, group: AdminTemplate[]) => {
    if (group.length === 0) return null;
    const allSelected = group.every((t) => selected.has(t.id));
    return (
      <div key={key} className="admin-template-category-section">
        <div className="row between admin-template-category-heading">
          <label className="row" style={{ gap: 6 }}>
            <input type="checkbox" checked={allSelected} onChange={() => toggleSelectGroup(group)} aria-label={`Select all templates in ${title}`} />
            <h2 style={{ margin: 0 }}>
              {title} <span className="hint">({group.length})</span>
            </h2>
          </label>
        </div>
        <div className="stack">{group.map(renderTemplateCard)}</div>
      </div>
    );
  };

  return (
    <div className="grid-2">
      {stepUpDialog}
      <div>
        <h1>Template library</h1>
        <p className="subtitle">
          Upload a PSD and publish it: every unlocked layer becomes an editable field. Lock layers in the workspace to keep them fixed. Replace PSD adds a new
          version to publish when it's ready: end users keep the current one until then, and projects already started stay on theirs.
        </p>
        {error && <div className="error-box">{error}</div>}
        {templates.length > 0 && (
          <div className="row between" style={{ marginBottom: 10 }}>
            <label className="row" style={{ gap: 6 }}>
              <input type="checkbox" checked={selected.size === templates.length} onChange={toggleSelectAll} aria-label="Select all templates" />
              <span className="hint">{selected.size > 0 ? `${selected.size} selected` : "Select all"}</span>
            </label>
            {selected.size > 0 && (
              <div className="row" style={{ gap: 8 }}>
                <button className="primary sm" disabled={bulkPublishing} onClick={bulkPublish}>
                  {bulkPublishing ? <Spinner /> : <Rocket size={14} aria-hidden="true" />}
                  Publish {selected.size} selected
                </button>
                <button className="danger sm" disabled={bulkDeleting} onClick={bulkRemove}>
                  {bulkDeleting ? <Spinner /> : null}
                  Delete {selected.size} selected
                </button>
              </div>
            )}
          </div>
        )}
        <div className="stack">
          {orderedCategories.map(({ category }) => renderCategorySection(category.id, categoryLabel(categories, category.id), templatesByCategory.get(category.id) ?? []))}
          {renderCategorySection("uncategorized", "Uncategorized", uncategorizedTemplates)}
          {templates.length === 0 && <p className="hint">No templates yet.</p>}
        </div>
      </div>
      <div className="card" style={{ height: "fit-content" }}>
        <h2>Upload templates</h2>
        <div className="row admin-upload-mode" role="radiogroup" aria-label="Upload mode" style={{ marginBottom: 12 }}>
          <label className={`upload-mode-option${uploadMode === "single" ? " selected" : ""}`}>
            <input type="radio" name="upload-mode" checked={uploadMode === "single"} onChange={() => setUploadMode("single")} />
            Single
          </label>
          <label className={`upload-mode-option${uploadMode === "bulk" ? " selected" : ""}`}>
            <input type="radio" name="upload-mode" checked={uploadMode === "bulk"} onChange={() => setUploadMode("bulk")} />
            Bulk import
          </label>
        </div>

        {uploadMode === "single" ? (
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
              <CategorySelect id="template-category" categories={categories} value={categoryId} onChange={setCategoryId} />
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
        ) : (
          <form onSubmit={bulkUpload} className="stack">
            <p className="hint" style={{ marginTop: 0 }}>
              Upload several PSDs at once into one category — each becomes its own template, named from its own filename.
            </p>
            <div>
              <label htmlFor="bulk-psd">PSD files</label>
              <input
                id="bulk-psd"
                ref={bulkFileInput}
                type="file"
                accept=".psd,.psb"
                multiple
                onChange={(e) => setBulkFiles(Array.from(e.target.files ?? []))}
                required
              />
            </div>
            <div>
              <label htmlFor="bulk-category">Category</label>
              <CategorySelect id="bulk-category" categories={categories} value={bulkCategoryId} onChange={setBulkCategoryId} />
            </div>
            <button type="submit" className="primary" disabled={bulkUploading || bulkFiles.length === 0 || !bulkCategoryId || categories.length === 0}>
              {bulkUploading ? <Spinner /> : null}
              Upload {bulkFiles.length > 0 ? `${bulkFiles.length} file(s)` : ""}
            </button>
            {categories.length === 0 && <p className="hint">Create a category first.</p>}
            {bulkResults && (
              <ul className="stack" style={{ fontSize: 13 }}>
                {bulkResults.map((r, i) => (
                  <li key={i} className={r.error ? "error-box" : "success-box"}>
                    {r.filename}: {r.error ?? "created"}
                  </li>
                ))}
              </ul>
            )}
          </form>
        )}
      </div>
    </div>
  );
}
