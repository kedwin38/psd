import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "../lib/auth-context";
import { logout } from "../lib/auth-api";

export function Layout() {
  const { user, signOut } = useAuth();
  const isAdmin = user?.roles.some((r) => r === "SUPER_ADMIN" || r === "CONTENT_ADMIN");
  const isAuditor = user?.roles.some((r) => r === "SUPER_ADMIN" || r === "AUDITOR");

  return (
    <div className="app-shell">
      <nav className="nav">
        <div className="brand">PSD Template Studio</div>
        <NavLink to="/" end>
          Templates
        </NavLink>
        {isAdmin && (
          <>
            <div className="hint" style={{ margin: "16px 8px 4px" }}>
              Admin
            </div>
            <NavLink to="/admin/categories">Categories</NavLink>
            <NavLink to="/admin/templates">Template Library</NavLink>
          </>
        )}
        {isAuditor && <NavLink to="/admin/audit-log">Audit Log</NavLink>}
        <div className="spacer" />
        <NavLink to="/account/totp">Security settings</NavLink>
        <div className="user-chip">
          <div>{user?.email}</div>
          <div>{user?.roles.join(", ")}</div>
          <button
            className="link"
            style={{ marginTop: 6 }}
            onClick={async () => {
              await logout();
              signOut();
            }}
          >
            Sign out
          </button>
        </div>
      </nav>
      <div className="main">
        <Outlet />
      </div>
    </div>
  );
}
