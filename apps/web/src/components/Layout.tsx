import { NavLink, Outlet, useMatch } from "react-router-dom";
import { FolderTree, LayoutGrid, Library, LogOut, ScrollText, ShieldCheck } from "lucide-react";
import { useAuth } from "../lib/auth-context";
import { logout } from "../lib/auth-api";
import { BrandMark } from "./workspace";

const ROLE_LABEL: Record<string, string> = {
  SUPER_ADMIN: "Super admin",
  CONTENT_ADMIN: "Content admin",
  ORG_ADMIN: "Org admin",
  AUDITOR: "Auditor",
  END_USER: "Member",
};

export function Layout() {
  const { user, signOut } = useAuth();
  // The editing workspaces own the whole viewport, like any creative tool; the console nav would only steal canvas width.
  const inEditor = useMatch("/projects/:projectId");
  const inWorkspace = useMatch("/admin/templates/:templateId/versions/:versionId");
  if (inEditor || inWorkspace) return <Outlet />;

  const isAdmin = user?.roles.some((r) => r === "SUPER_ADMIN" || r === "CONTENT_ADMIN");
  const isAuditor = user?.roles.some((r) => r === "SUPER_ADMIN" || r === "AUDITOR");
  const topRole = user?.roles.find((r) => r !== "END_USER") ?? user?.roles[0];

  return (
    <div className="app-shell">
      <nav className="nav" aria-label="Main">
        <div className="brand">
          <BrandMark />
          PSD Template Studio
        </div>
        <NavLink to="/" end>
          <LayoutGrid size={17} aria-hidden="true" />
          Templates
        </NavLink>
        {isAdmin && (
          <>
            <div className="nav-section">Admin</div>
            <NavLink to="/admin/categories">
              <FolderTree size={17} aria-hidden="true" />
              Categories
            </NavLink>
            <NavLink to="/admin/templates">
              <Library size={17} aria-hidden="true" />
              Template Library
            </NavLink>
          </>
        )}
        {isAuditor && (
          <NavLink to="/admin/audit-log">
            <ScrollText size={17} aria-hidden="true" />
            Audit Log
          </NavLink>
        )}
        <div className="spacer" />
        <NavLink to="/account/totp">
          <ShieldCheck size={17} aria-hidden="true" />
          Security settings
        </NavLink>
        <div className="user-chip">
          <span className="avatar" aria-hidden="true">
            {user?.email.slice(0, 2)}
          </span>
          <div className="who">
            <div className="email" title={user?.email}>
              {user?.email}
            </div>
            <div className="roles" title={user?.roles.join(", ")}>
              {topRole ? (ROLE_LABEL[topRole] ?? topRole) : ""}
            </div>
          </div>
          <button
            type="button"
            className="icon-btn sm"
            aria-label="Sign out"
            data-tip="Sign out"
            data-tip-pos="top"
            data-tip-align="end"
            onClick={async () => {
              await logout();
              signOut();
            }}
          >
            <LogOut size={16} aria-hidden="true" />
          </button>
        </div>
      </nav>
      <div className="main">
        <Outlet />
      </div>
    </div>
  );
}
