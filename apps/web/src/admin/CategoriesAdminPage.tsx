import { useEffect, useState } from "react";
import { api, ApiError } from "../lib/api";
import type { Category } from "../lib/types";

export function CategoriesAdminPage() {
  const [categories, setCategories] = useState<Category[]>([]);
  const [name, setName] = useState("");
  const [parentId, setParentId] = useState("");
  const [visibility, setVisibility] = useState<Category["visibility"]>("PUBLIC");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => api.get<Category[]>("/categories").then(setCategories);

  useEffect(() => {
    load();
  }, []);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api.post("/categories", { name, parentId: parentId || null, visibility });
      setName("");
      setParentId("");
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? (err.detail ?? err.title) : "Could not create category.");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    if (!confirm("Delete this category?")) return;
    try {
      await api.del(`/categories/${id}`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? (err.detail ?? err.title) : "Could not delete category.");
    }
  };

  return (
    <div className="grid-2">
      <div>
        <h1>Categories</h1>
        <p className="subtitle">The taxonomy end users browse templates by (spec §10).</p>
        {error && <div className="error-box">{error}</div>}
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Parent</th>
              <th>Visibility</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {categories.map((c) => (
              <tr key={c.id}>
                <td>{c.name}</td>
                <td className="hint">{categories.find((p) => p.id === c.parentId)?.name ?? "—"}</td>
                <td>{c.visibility}</td>
                <td>
                  <button className="link" onClick={() => remove(c.id)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
            {categories.length === 0 && (
              <tr>
                <td colSpan={4} className="hint">
                  No categories yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="card" style={{ height: "fit-content" }}>
        <h2>New category</h2>
        <form onSubmit={create} className="stack">
          <div>
            <label htmlFor="category-name">Name</label>
            <input id="category-name" value={name} onChange={(e) => setName(e.target.value)} required />
          </div>
          <div>
            <label htmlFor="category-parent">Parent (optional)</label>
            <select id="category-parent" value={parentId} onChange={(e) => setParentId(e.target.value)}>
              <option value="">None (top-level)</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="category-visibility">Visibility</label>
            <select id="category-visibility" value={visibility} onChange={(e) => setVisibility(e.target.value as Category["visibility"])}>
              <option value="PUBLIC">Public</option>
              <option value="ORG_RESTRICTED">Org-restricted</option>
              <option value="PLAN_TIER">Plan-tier gated</option>
            </select>
          </div>
          <button type="submit" className="primary" disabled={busy}>
            Create category
          </button>
        </form>
      </div>
    </div>
  );
}
