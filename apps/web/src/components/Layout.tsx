import { NavLink, Outlet, useMatch } from "react-router-dom";
import { Droplets, FolderTree, LayoutGrid, Library, LogOut, MessageCircle, ScrollText, ShieldCheck, Users } from "lucide-react";
import { useAuth } from "../lib/auth-context";
import { logout } from "../lib/auth-api";
import type { RoleName } from "../lib/types";
import { BrandMark } from "./workspace";

export const ROLE_LABEL: Record<RoleName, string> = {
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
  const isSuperAdmin = user?.roles.includes("SUPER_ADMIN");
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
        <NavLink to={isAdmin ? "/admin/messages" : "/messages"}>
          <MessageCircle size={17} aria-hidden="true" />
          {isAdmin ? "Messages" : "Contact support"}
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
        {isSuperAdmin && (
          <NavLink to="/admin/users">
            <Users size={17} aria-hidden="true" />
            Users
          </NavLink>
        )}
        {isAdmin && (
          <NavLink to="/admin/settings">
            <Droplets size={17} aria-hidden="true" />
            Settings
          </NavLink>
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
