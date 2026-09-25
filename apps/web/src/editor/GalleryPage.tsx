import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ChevronRight, LayoutTemplate, Search } from "lucide-react";
import { api, ApiError } from "../lib/api";
import type { Category, Project, Template } from "../lib/types";
import { categoryPath, categoryTree, findCategoryNode, subtreeIds, type CategoryNode } from "../lib/categories";
import { TemplateThumbnail } from "../components/TemplateThumbnail";

type Sort = "newest" | "name";

/** Must match MAX_PENDING_PROJECTS in apps/api/src/projects/projects.service.ts. */
const MAX_PENDING_PROJECTS = 2;

const errorText = (err: unknown, fallback: string) => (err instanceof ApiError ? (err.detail ?? err.title) : fallback);

function ProjectNameCell({ project, busy, onRename }: { project: Project; busy: boolean; onRename: (name: string) => Promise<boolean> }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(project.name);

  if (!editing) {
    return (
      <button type="button" className="link project-name" onClick={() => { setDraft(project.name); setEditing(true); }} aria-label={`Rename ${project.name}`}>
        {project.name}
      </button>
    );
  }

  const commit = async () => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== project.name) await onRename(trimmed);
    setEditing(false);
  };

  return (
    <input
      autoFocus
      value={draft}
      disabled={busy}
      aria-label="Project name"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          void commit();
        } else if (e.key === "Escape") {
          setDraft(project.name);
          setEditing(false);
        }
      }}
    />
  );
}

const categoryHref = (id: string | null) => (id ? `/?category=${id}` : "/");

function CategoryTreeList({
  nodes,
  counts,
  selectedId,
  expanded,
  onToggle,
}: {
  nodes: CategoryNode[];
  counts: Map<string, number>;
  selectedId: string | null;
  expanded: Set<string>;
  onToggle: (id: string) => void;
}) {
  return (
    <ul>
      {nodes
        .filter((c) => counts.get(c.id))
        .map((c) => {
          const children = c.children.filter((child) => counts.get(child.id));
          const open = expanded.has(c.id);
          return (
            <li key={c.id}>
              <div className="catalog-cat">
                {children.length > 0 ? (
                  <button type="button" className="layer-caret" aria-expanded={open} aria-label={`${open ? "Collapse" : "Expand"} ${c.name}`} onClick={() => onToggle(c.id)}>
                    <ChevronRight size={14} aria-hidden="true" style={{ transform: open ? "rotate(90deg)" : undefined }} />
                  </button>
                ) : (
                  <span className="layer-caret" />
                )}
                <Link to={categoryHref(c.id)} aria-current={c.id === selectedId ? "page" : undefined}>
                  <span className="name">{c.name}</span>
                  <span className="panel-count">{counts.get(c.id)}</span>
                </Link>
              </div>
              {open && children.length > 0 && <CategoryTreeList nodes={children} counts={counts} selectedId={selectedId} expanded={expanded} onToggle={onToggle} />}
            </li>
          );
        })}
    </ul>
  );
}

export function GalleryPage() {
  const [templates, setTemplates] = useState<Template[] | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [myProjects, setMyProjects] = useState<Project[]>([]);
  const [creatingFor, setCreatingFor] = useState<string | null>(null);
  const [busyProjectId, setBusyProjectId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>("newest");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [params] = useSearchParams();
  const navigate = useNavigate();

  const loadProjects = () => api.get<Project[]>("/projects").then(setMyProjects);

  useEffect(() => {
    api.get<Template[]>("/templates").then(setTemplates);
    api.get<Category[]>("/categories").then(setCategories);
    loadProjects();
  }, []);

  const pendingCount = myProjects.filter((p) => p.status === "IN_PROGRESS").length;
  const atPendingCap = pendingCount >= MAX_PENDING_PROJECTS;

  const selected = categories.find((c) => c.id === params.get("category")) ?? null;
  const path = categoryPath(categories, selected?.id ?? null);
  const tree = useMemo(() => categoryTree(categories), [categories]);

  // Published templates in each category, counting its subcategories'.
  const counts = useMemo(() => {
    const direct = new Map<string, number>();
    for (const t of templates ?? []) direct.set(t.categoryId, (direct.get(t.categoryId) ?? 0) + 1);
    const total = (node: CategoryNode): number => node.children.reduce((sum, child) => sum + total(child), direct.get(node.id) ?? 0);
    const counts = new Map<string, number>();
    const visit = (nodes: CategoryNode[]) => {
      for (const node of nodes) {
        counts.set(node.id, total(node));
        visit(node.children);
      }
    };
    visit(tree);
    return counts;
  }, [templates, tree]);

  // Opening a category unfolds the tree down to it, like a shop's department menu.
  useEffect(() => {
    if (path.length) setExpanded((prev) => new Set([...prev, ...path.map((c) => c.id)]));
  }, [selected?.id, categories]);

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const shown = useMemo(() => {
    const inCategory = selected ? subtreeIds(categories, selected.id) : null;
    const needle = query.trim().toLowerCase();
    const list = (templates ?? []).filter((t) => (!inCategory || inCategory.has(t.categoryId)) && t.name.toLowerCase().includes(needle));
    return sort === "name" ? [...list].sort((a, b) => a.name.localeCompare(b.name)) : list;
  }, [templates, categories, selected, query, sort]);

  const subcategories = (selected ? findCategoryNode(tree, selected.id)?.children : tree) ?? [];

  const startProject = async (template: Template) => {
    if (creatingFor) return;
    if (atPendingCap) {
      setError(`You already have ${MAX_PENDING_PROJECTS} pending projects. Clear one to start another.`);
      return;
    }
    setCreatingFor(template.id);
    setError(null);
    try {
      const project = await api.post<Project>("/projects", { templateId: template.id, name: `${template.name} project` });
      navigate(`/projects/${project.id}`);
    } catch (err) {
      setError(errorText(err, "Could not start a project from this template."));
    } finally {
      setCreatingFor(null);
    }
  };

  const renameProject = async (project: Project, name: string) => {
    setBusyProjectId(project.id);
    setError(null);
    try {
      await api.patch(`/projects/${project.id}`, { name });
      await loadProjects();
      return true;
    } catch (err) {
      setError(errorText(err, "Could not rename project."));
      return false;
    } finally {
      setBusyProjectId(null);
    }
  };

  const deleteProject = async (project: Project) => {
    if (!confirm(`Clear “${project.name}”? This permanently deletes the project and its uploaded photos. This can't be undone.`)) return;
    setBusyProjectId(project.id);
    setError(null);
    try {
      await api.del(`/projects/${project.id}`);
      await loadProjects();
    } catch (err) {
      setError(errorText(err, "Could not delete project."));
    } finally {
      setBusyProjectId(null);
    }
  };

  return (
    <div className="stack gallery">
      {myProjects.length > 0 && (
        <div>
          <div className="row between">
            <h2>Your projects</h2>
            <span className={`badge plain ${atPendingCap ? "pending-cap-reached" : ""}`}>
              {pendingCount}/{MAX_PENDING_PROJECTS} pending{atPendingCap ? " — clear one to start another" : ""}
            </span>
          </div>
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {myProjects.map((p) => (
                <tr key={p.id}>
                  <td>
                    <ProjectNameCell project={p} busy={busyProjectId === p.id} onRename={(name) => renameProject(p, name)} />
                  </td>
                  <td>
                    <span className={`badge ${p.status}`}>{p.status}</span>
                  </td>
                  <td>
                    <div className="row end">
                      <button className="link" onClick={() => navigate(`/projects/${p.id}`)} disabled={busyProjectId === p.id}>
                        Open →
                      </button>
                      <button className="link danger" onClick={() => deleteProject(p)} disabled={busyProjectId === p.id} aria-label={`Clear ${p.name}`}>
                        Clear
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="catalog">
        <aside className="catalog-sidebar">
          <div className="section-title">Categories</div>
          <nav aria-label="Categories" className="catalog-tree">
            <div className="catalog-cat">
              <Link to="/" aria-current={selected ? undefined : "page"}>
                <span className="name">All templates</span>
                <span className="panel-count">{templates?.length ?? 0}</span>
              </Link>
            </div>
            <CategoryTreeList nodes={tree} counts={counts} selectedId={selected?.id ?? null} expanded={expanded} onToggle={toggle} />
          </nav>
        </aside>

        <section className="catalog-main" aria-labelledby="catalog-title">
          <nav aria-label="Breadcrumb" className="breadcrumbs">
            <ol>
              <li>{selected ? <Link to="/">All templates</Link> : <span aria-current="page">All templates</span>}</li>
              {path.map((c) => (
                <li key={c.id}>{c.id === selected?.id ? <span aria-current="page">{c.name}</span> : <Link to={categoryHref(c.id)}>{c.name}</Link>}</li>
              ))}
            </ol>
          </nav>
          <div className="catalog-header">
            <div>
              <h1 id="catalog-title">{selected?.name ?? "All templates"}</h1>
              <p className="subtitle">{templates ? `${shown.length} ${shown.length === 1 ? "template" : "templates"} · pick one to start customizing` : "Loading templates…"}</p>
            </div>
            <div className="catalog-tools">
              <div className="search-field">
                <Search size={14} aria-hidden="true" />
                <input type="search" placeholder="Search templates" aria-label="Search templates" value={query} onChange={(e) => setQuery(e.target.value)} />
              </div>
              <select aria-label="Sort templates" value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
                <option value="newest">Newest</option>
                <option value="name">Name A–Z</option>
              </select>
            </div>
          </div>

          {subcategories.some((c) => counts.get(c.id)) && (
            <div className="subcategory-chips" aria-label={selected ? `Inside ${selected.name}` : "Shop by category"} role="group">
              {subcategories
                .filter((c) => counts.get(c.id))
                .map((c) => (
                  <Link key={c.id} to={categoryHref(c.id)} className="subcategory-chip">
                    {c.name}
                    <span className="panel-count">{counts.get(c.id)}</span>
                  </Link>
                ))}
            </div>
          )}

          {error && <div className="error-box">{error}</div>}

          <div className="template-grid">
            {templates === null &&
              Array.from({ length: 6 }, (_, i) => (
                <div className="template-card loading" key={i} aria-hidden="true">
                  <div className="template-thumb">
                    <div className="skeleton" />
                  </div>
                  <div className="body">
                    <div className="skeleton" style={{ height: 14, width: "60%" }} />
                  </div>
                </div>
              ))}
            {shown.map((t) => (
              <div
                className={`template-card ${atPendingCap ? "at-cap" : ""}`}
                key={t.id}
                role="button"
                tabIndex={0}
                aria-busy={creatingFor === t.id}
                title={atPendingCap ? `You already have ${MAX_PENDING_PROJECTS} pending projects. Clear one to start another.` : undefined}
                onClick={() => startProject(t)}
                onKeyDown={(e) => {
                  if (e.key !== "Enter" && e.key !== " ") return;
                  e.preventDefault();
                  startProject(t);
                }}
              >
                <TemplateThumbnail template={t} className={creatingFor === t.id ? "creating" : ""} />
                <div className="body">
                  <h3>{t.name}</h3>
                  <p className="hint">{categories.find((c) => c.id === t.categoryId)?.name ?? "Template"}</p>
                </div>
              </div>
            ))}
          </div>
          {templates !== null && shown.length === 0 && (
            <div className="empty-state">
              <span className="empty-icon">
                <LayoutTemplate size={22} aria-hidden="true" />
              </span>
              <p className="empty-title">{templates.length === 0 ? "No published templates yet" : "No templates match"}</p>
              <p>{templates.length === 0 ? "Templates appear here as soon as an admin publishes them." : "Try another category or search term."}</p>
              {(selected || query) && templates.length > 0 && (
                <div className="actions">
                  <Link to="/" className="btn" onClick={() => setQuery("")}>
                    Browse all templates
                  </Link>
                </div>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
