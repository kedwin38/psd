import { useEffect, useState } from "react";
import { api, ApiError } from "../lib/api";
import type { Category } from "../lib/types";
import { categoryLabel, categoryTree, flattenTree, subtreeIds } from "../lib/categories";
import { useStepUp } from "../components/StepUpDialog";

type Draft = Pick<Category, "name" | "parentId" | "visibility">;

const errorText = (err: unknown, fallback: string) => (err instanceof ApiError ? (err.detail ?? err.title) : fallback);

function ParentSelect({ id, categories, value, exclude, onChange }: { id: string; categories: Category[]; value: string | null; exclude?: Set<string>; onChange: (parentId: string | null) => void }) {
  return (
    <select id={id} value={value ?? ""} onChange={(e) => onChange(e.target.value || null)}>
      <option value="">None (top-level)</option>
      {flattenTree(categoryTree(categories))
        .filter(({ category }) => !exclude?.has(category.id))
        .map(({ category }) => (
          <option key={category.id} value={category.id}>
            {categoryLabel(categories, category.id)}
          </option>
        ))}
    </select>
  );
}

function VisibilitySelect({ id, value, onChange }: { id: string; value: Category["visibility"]; onChange: (visibility: Category["visibility"]) => void }) {
  return (
    <select id={id} value={value} onChange={(e) => onChange(e.target.value as Category["visibility"])}>
      <option value="PUBLIC">Public</option>
      <option value="ORG_RESTRICTED">Org-restricted</option>
      <option value="PLAN_TIER">Plan-tier gated</option>
    </select>
  );
}

export function CategoriesAdminPage() {
  const [categories, setCategories] = useState<Category[]>([]);
  const [draft, setDraft] = useState<Draft>({ name: "", parentId: null, visibility: "PUBLIC" });
  const [editing, setEditing] = useState<(Draft & { id: string }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { stepUp, dialog: stepUpDialog } = useStepUp();

  const load = () => api.get<Category[]>("/categories").then(setCategories);

  useEffect(() => {
    load();
  }, []);

  const run = async (action: () => Promise<unknown>, fallback: string) => {
    setError(null);
    setBusy(true);
    try {
      await action();
      await load();
      return true;
    } catch (err) {
      setError(errorText(err, fallback));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (await run(() => api.post("/categories", draft), "Could not create category.")) setDraft({ name: "", parentId: null, visibility: "PUBLIC" });
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    const { id, ...changes } = editing;
    if (await run(() => api.patch(`/categories/${id}`, changes), "Could not save category.")) setEditing(null);
  };

  const remove = async (category: Category) => {
    if (!confirm(`Delete the category “${category.name}”?`)) return;
    await run(async () => {
      const stepUpToken = await stepUp();
      if (stepUpToken) await api.del(`/categories/${category.id}`, stepUpToken);
    }, "Could not delete category.");
  };

  return (
    <div className="grid-2">
      {stepUpDialog}
      <div>
        <h1>Categories</h1>
        <p className="subtitle">The catalog end users browse templates by. Nest a category under another to make it a subcategory.</p>
        {error && <div className="error-box">{error}</div>}
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Visibility</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {flattenTree(categoryTree(categories)).map(({ category: c, depth }) =>
              editing?.id === c.id ? (
                <tr key={c.id}>
                  <td colSpan={3}>
                    <form onSubmit={save} className="category-edit">
                      <div>
                        <label htmlFor="edit-category-name">Name</label>
                        <input id="edit-category-name" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} required autoFocus />
                      </div>
                      <div>
                        <label htmlFor="edit-category-parent">Parent</label>
                        <ParentSelect
                          id="edit-category-parent"
                          categories={categories}
                          value={editing.parentId}
                          exclude={subtreeIds(categories, c.id)}
                          onChange={(parentId) => setEditing({ ...editing, parentId })}
                        />
                      </div>
                      <div>
                        <label htmlFor="edit-category-visibility">Visibility</label>
                        <VisibilitySelect id="edit-category-visibility" value={editing.visibility} onChange={(visibility) => setEditing({ ...editing, visibility })} />
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
                  </td>
                </tr>
              ) : (
                <tr key={c.id}>
                  <td>
                    <span className="category-name" style={{ paddingLeft: depth * 20 }}>
                      {depth > 0 && <span className="category-branch" aria-hidden="true" />}
                      {c.name}
                    </span>
                  </td>
                  <td>{c.visibility}</td>
                  <td>
                    <div className="row end">
                      <button className="link" onClick={() => setEditing({ id: c.id, name: c.name, parentId: c.parentId, visibility: c.visibility })} aria-label={`Edit ${c.name}`}>
                        Edit
                      </button>
                      <button className="link" onClick={() => remove(c)} disabled={busy} aria-label={`Delete ${c.name}`}>
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ),
            )}
            {categories.length === 0 && (
              <tr>
                <td colSpan={3} className="hint">
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
            <input id="category-name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} required />
          </div>
          <div>
            <label htmlFor="category-parent">Parent (optional)</label>
            <ParentSelect id="category-parent" categories={categories} value={draft.parentId} onChange={(parentId) => setDraft({ ...draft, parentId })} />
          </div>
          <div>
            <label htmlFor="category-visibility">Visibility</label>
            <VisibilitySelect id="category-visibility" value={draft.visibility} onChange={(visibility) => setDraft({ ...draft, visibility })} />
          </div>
          <button type="submit" className="primary" disabled={busy}>
            Create category
          </button>
        </form>
      </div>
    </div>
  );
}
