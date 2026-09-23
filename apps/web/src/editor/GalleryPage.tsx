import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import type { Category, Project, Template } from "../lib/types";

export function GalleryPage() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [myProjects, setMyProjects] = useState<Project[]>([]);
  const [creatingFor, setCreatingFor] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    api.get<Template[]>("/templates").then(setTemplates);
    api.get<Category[]>("/categories").then(setCategories);
    api.get<Project[]>("/projects").then(setMyProjects);
  }, []);

  const startProject = async (template: Template) => {
    setCreatingFor(template.id);
    try {
      const project = await api.post<Project>("/projects", { templateId: template.id, name: `${template.name} project` });
      navigate(`/projects/${project.id}`);
    } finally {
      setCreatingFor(null);
    }
  };

  return (
    <div className="stack">
      {myProjects.length > 0 && (
        <div>
          <h2>Your projects</h2>
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
                  <td>{p.name}</td>
                  <td>
                    <span className={`badge ${p.status}`}>{p.status}</span>
                  </td>
                  <td>
                    <button className="link" onClick={() => navigate(`/projects/${p.id}`)}>
                      Open →
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div>
        <h1>Templates</h1>
        <p className="subtitle">Pick a template to start customizing.</p>
        <div className="template-grid">
          {templates.map((t) => (
            <div className="template-card" key={t.id} onClick={() => startProject(t)}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "center", aspectRatio: "4/3", background: "var(--surface-2)", color: "var(--text-dim)", fontSize: 13 }}>
                {creatingFor === t.id ? "Creating…" : categories.find((c) => c.id === t.categoryId)?.name ?? "Template"}
              </div>
              <div className="body">
                <h3 style={{ margin: 0 }}>{t.name}</h3>
              </div>
            </div>
          ))}
          {templates.length === 0 && <p className="hint">No published templates yet.</p>}
        </div>
      </div>
    </div>
  );
}
