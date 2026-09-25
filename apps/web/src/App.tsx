import { Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "./lib/auth-context";
import { Layout } from "./components/Layout";
import { LoginPage } from "./auth/LoginPage";
import { RegisterPage } from "./auth/RegisterPage";
import { TotpEnrollPage } from "./auth/TotpEnrollPage";
import { MfaSetupPage } from "./auth/MfaSetupPage";
import { GalleryPage } from "./editor/GalleryPage";
import { ProjectEditorPage } from "./editor/ProjectEditorPage";
import { CategoriesAdminPage } from "./admin/CategoriesAdminPage";
import { TemplatesAdminPage } from "./admin/TemplatesAdminPage";
import { TemplateWorkspacePage } from "./admin/TemplateWorkspacePage";
import { AuditLogPage } from "./admin/AuditLogPage";
import { UsersAdminPage } from "./admin/UsersAdminPage";
import { SettingsAdminPage } from "./admin/SettingsAdminPage";
import { MessagesAdminPage } from "./admin/MessagesAdminPage";
import { MessagesPage } from "./messages/MessagesPage";
import type { RoleName } from "./lib/types";

function ProtectedRoute({ children, roles }: { children: React.ReactNode; roles?: RoleName[] }) {
  const { user, loading } = useAuth();
  if (loading)
    return (
      <div className="center-page" style={{ color: "var(--text-dim)" }}>
        <span className="spinner lg" role="status" aria-label="Loading" />
      </div>
    );
  if (!user) return <Navigate to="/login" replace />;
  if (user.mfaSetupRequired) return <MfaSetupPage />;
  if (roles && !roles.some((r) => user.roles.includes(r))) return <Navigate to="/" replace />;
  return <>{children}</>;
}

const ADMIN_ROLES: RoleName[] = ["SUPER_ADMIN", "CONTENT_ADMIN"];

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />

      <Route
        element={
          <ProtectedRoute>
            <Layout />
          </ProtectedRoute>
        }
      >
        <Route path="/" element={<GalleryPage />} />
        <Route path="/projects/:projectId" element={<ProjectEditorPage />} />
        <Route path="/messages" element={<MessagesPage />} />
        <Route path="/account/totp" element={<TotpEnrollPage />} />

        <Route
          path="/admin/categories"
          element={
            <ProtectedRoute roles={ADMIN_ROLES}>
              <CategoriesAdminPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/admin/templates"
          element={
            <ProtectedRoute roles={ADMIN_ROLES}>
              <TemplatesAdminPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/admin/templates/:templateId/versions/:versionId"
          element={
            <ProtectedRoute roles={ADMIN_ROLES}>
              <TemplateWorkspacePage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/admin/settings"
          element={
            <ProtectedRoute roles={ADMIN_ROLES}>
              <SettingsAdminPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/admin/users"
          element={
            <ProtectedRoute roles={["SUPER_ADMIN"]}>
              <UsersAdminPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/admin/messages"
          element={
            <ProtectedRoute roles={["SUPER_ADMIN", "CONTENT_ADMIN", "ORG_ADMIN"]}>
              <MessagesAdminPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/admin/audit-log"
          element={
            <ProtectedRoute roles={["SUPER_ADMIN", "AUDITOR"]}>
              <AuditLogPage />
            </ProtectedRoute>
          }
        />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
