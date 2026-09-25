import { useEffect, useRef, useState } from "react";
import { Search, UserPlus, X } from "lucide-react";
import { api, ApiError } from "../lib/api";
import { useAuth } from "../lib/auth-context";
import type { AdminUser, RoleAssignment, RoleName, UserStatus } from "../lib/types";
import { useStepUp } from "../components/StepUpDialog";
import { ROLE_LABEL } from "../components/Layout";
import { Spinner } from "../components/workspace";

const ROLES: RoleName[] = ["SUPER_ADMIN", "CONTENT_ADMIN", "ORG_ADMIN", "AUDITOR", "END_USER"];

const STATUS_LABEL: Record<UserStatus, string> = {
  ACTIVE: "Active",
  SUSPENDED: "Suspended",
  PENDING_VERIFICATION: "Pending verification",
};

const errorText = (err: unknown, fallback: string) => (err instanceof ApiError ? (err.detail ?? err.title) : fallback);

const isScoped = (a: RoleAssignment) => a.organizationId !== null || a.categoryId !== null;

interface NewUser {
  email: string;
  displayName: string;
  role: RoleName;
  password: string;
}

const PASSWORD_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

function generatePassword(length = 20): string {
  // Rejection sampling keeps every character equally likely.
  const limit = 256 - (256 % PASSWORD_ALPHABET.length);
  let out = "";
  while (out.length < length) {
    for (const byte of crypto.getRandomValues(new Uint8Array(length))) {
      if (byte < limit && out.length < length) out += PASSWORD_ALPHABET[byte % PASSWORD_ALPHABET.length];
    }
  }
  return out;
}

export function UsersAdminPage() {
  const { user: me } = useAuth();
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  // The user whose change is in flight; their row's controls wait for it.
  const [pending, setPending] = useState<string | null>(null);
  const [roleToAdd, setRoleToAdd] = useState<Record<string, RoleName | "">>({});
  const [downloadsToAdd, setDownloadsToAdd] = useState<Record<string, string>>({});
  const [confirmingSuspend, setConfirmingSuspend] = useState<AdminUser | null>(null);
  const [creating, setCreating] = useState(false);
  const { stepUp, dialog: stepUpDialog } = useStepUp();

  const load = () => api.get<AdminUser[]>("/admin/users").then(setUsers);

  useEffect(() => {
    load().catch((err) => setError(errorText(err, "Could not load users.")));
  }, []);

  const q = query.trim().toLowerCase();
  const visible = (users ?? []).filter((u) => !q || u.email.toLowerCase().includes(q) || u.displayName.toLowerCase().includes(q));

  /** Re-authenticates, then makes the change; resolves true once it's saved. */
  const change = async (userId: string, action: (stepUpToken: string) => Promise<unknown>, fallback: string) => {
    setError(null);
    setPending(userId);
    try {
      const stepUpToken = await stepUp();
      if (!stepUpToken) return false;
      await action(stepUpToken);
      await load();
      return true;
    } catch (err) {
      setError(errorText(err, fallback));
      return false;
    } finally {
      setPending(null);
    }
  };

  const addRole = async (user: AdminUser, role: RoleName) => {
    const saved = await change(user.id, (token) => api.post(`/admin/users/${user.id}/roles`, { role }, token), "Could not add the role.");
    if (saved) setRoleToAdd((prev) => ({ ...prev, [user.id]: "" }));
  };

  const removeRole = (user: AdminUser, assignment: RoleAssignment) =>
    change(user.id, (token) => api.del(`/admin/roles/${assignment.id}`, token), "Could not remove the role.");

  const setStatus = (user: AdminUser, status: "ACTIVE" | "SUSPENDED") =>
    change(user.id, (token) => api.patch(`/admin/users/${user.id}/status`, { status }, token), "Could not change the account's status.");

  const grantDownloads = async (user: AdminUser, add: number) => {
    const saved = await change(user.id, (token) => api.patch(`/admin/users/${user.id}/downloads`, { add }, token), "Could not grant more downloads.");
    if (saved) setDownloadsToAdd((prev) => ({ ...prev, [user.id]: "" }));
  };

  /** Re-authenticates, then creates the account; resolves false if the admin cancels the step-up. */
  const createUser = async (body: NewUser) => {
    const stepUpToken = await stepUp();
    if (!stepUpToken) return false;
    await api.post("/admin/users", body, stepUpToken);
    await load();
    return true;
  };

  return (
    <div>
      {creating && <CreateUserDialog onCreate={createUser} onClose={() => setCreating(false)} />}
      {stepUpDialog}
      {confirmingSuspend && (
        <SuspendDialog
          user={confirmingSuspend}
          onCancel={() => setConfirmingSuspend(null)}
          onConfirm={() => {
            setConfirmingSuspend(null);
            void setStatus(confirmingSuspend, "SUSPENDED");
          }}
        />
      )}
      <div className="row between">
        <div>
          <h1>Users</h1>
          <p className="subtitle">Everyone who has signed up: their roles, and whether they can sign in.</p>
        </div>
        <div className="row">
          <div className="search-field users-search">
            <Search size={14} aria-hidden="true" />
            <input type="search" placeholder="Search by name or email" aria-label="Search users" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          <button type="button" className="primary" onClick={() => setCreating(true)}>
            <UserPlus size={15} aria-hidden="true" />
            Create user
          </button>
        </div>
      </div>
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}
      <table>
        <thead>
          <tr>
            <th>User</th>
            <th>Status</th>
            <th>Roles</th>
            <th>Downloads</th>
            <th>MFA</th>
            <th>Signed up</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {visible.map((u) => {
            const busy = pending === u.id;
            const isMe = u.id === me?.id;
            const addable = ROLES.filter((r) => !u.roles.some((a) => a.role === r && !isScoped(a)));
            const selected = roleToAdd[u.id] ?? "";
            return (
              <tr key={u.id}>
                <td>
                  <div>
                    {u.displayName}
                    {isMe && <span className="badge plain users-you">You</span>}
                  </div>
                  <div className="hint">{u.email}</div>
                </td>
                <td>
                  <span className={`badge ${u.status}`}>{STATUS_LABEL[u.status]}</span>
                </td>
                <td>
                  <div className="user-roles">
                    {u.roles.map((a) => (
                      <span key={a.id} className="badge plain role-chip" title={isScoped(a) ? "Scoped to one organization or category" : undefined}>
                        {ROLE_LABEL[a.role]}
                        {isScoped(a) && " (scoped)"}
                        <button type="button" className="icon-btn sm" aria-label={`Remove ${ROLE_LABEL[a.role]} role from ${u.email}`} disabled={busy} onClick={() => removeRole(u, a)}>
                          <X size={12} aria-hidden="true" />
                        </button>
                      </span>
                    ))}
                    {u.roles.length === 0 && <span className="hint">No roles</span>}
                  </div>
                  {addable.length > 0 && (
                    <form
                      className="row user-role-add"
                      onSubmit={(e) => {
                        e.preventDefault();
                        if (selected) void addRole(u, selected);
                      }}
                    >
                      <select aria-label={`Role to add for ${u.email}`} value={selected} disabled={busy} onChange={(e) => setRoleToAdd((prev) => ({ ...prev, [u.id]: e.target.value as RoleName }))}>
                        <option value="">Add a role…</option>
                        {addable.map((r) => (
                          <option key={r} value={r}>
                            {ROLE_LABEL[r]}
                          </option>
                        ))}
                      </select>
                      <button type="submit" className="sm" disabled={busy || !selected} aria-label={`Add role for ${u.email}`}>
                        Add
                      </button>
                    </form>
                  )}
                </td>
                <td>
                  <span className={u.downloadsUsed >= u.downloadsAllowed ? "hint danger-text" : "hint"}>
                    {u.downloadsUsed}/{u.downloadsAllowed}
                  </span>
                  <form
                    className="row user-role-add"
                    onSubmit={(e) => {
                      e.preventDefault();
                      const add = Number(downloadsToAdd[u.id]);
                      if (add > 0) void grantDownloads(u, add);
                    }}
                  >
                    <input
                      type="number"
                      min={1}
                      max={1000}
                      className="sm downloads-add-input"
                      aria-label={`Downloads to add for ${u.email}`}
                      placeholder="+"
                      disabled={busy}
                      value={downloadsToAdd[u.id] ?? ""}
                      onChange={(e) => setDownloadsToAdd((prev) => ({ ...prev, [u.id]: e.target.value }))}
                    />
                    <button type="submit" className="sm" disabled={busy || !(Number(downloadsToAdd[u.id]) > 0)} aria-label={`Grant downloads to ${u.email}`}>
                      Grant
                    </button>
                  </form>
                </td>
                <td>
                  {u.mfaEnrolled ? (
                    "Enrolled"
                  ) : u.mfaSetupRequired ? (
                    <span className="hint" title="Has an admin role, so it can't do anything until it enrolls an authenticator app.">
                      Setup required
                    </span>
                  ) : (
                    <span className="hint">Not enrolled</span>
                  )}
                </td>
                <td className="hint">{new Date(u.createdAt).toLocaleDateString()}</td>
                <td>
                  {u.status === "SUSPENDED" ? (
                    <button type="button" className="sm" disabled={busy} aria-label={`Reactivate ${u.email}`} onClick={() => setStatus(u, "ACTIVE")}>
                      {busy && <Spinner />}
                      Reactivate
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="sm danger"
                      disabled={busy || isMe}
                      title={isMe ? "You can't suspend your own account." : undefined}
                      aria-label={`Suspend ${u.email}`}
                      onClick={() => setConfirmingSuspend(u)}
                    >
                      {busy && <Spinner />}
                      Suspend
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
          {users === null && !error && (
            <tr>
              <td colSpan={7} className="hint">
                <Spinner /> Loading users…
              </td>
            </tr>
          )}
          {users !== null && visible.length === 0 && (
            <tr>
              <td colSpan={7} className="hint">
                {users.length === 0 ? "No users yet." : `No users match “${query.trim()}”.`}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function SuspendDialog({ user, onCancel, onConfirm }: { user: AdminUser; onCancel: () => void; onConfirm: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => dialog.current?.showModal(), []);

  return (
    <dialog
      ref={dialog}
      className="step-up-dialog"
      aria-labelledby="suspend-title"
      onCancel={(e) => {
        e.preventDefault();
        onCancel();
      }}
    >
      <div className="stack">
        <h2 id="suspend-title">Suspend {user.displayName}?</h2>
        <p className="hint">
          {user.email} will be signed out everywhere at once and won't be able to sign in again until an admin reactivates the account.
        </p>
        <div className="row end">
          <button type="button" onClick={onCancel} autoFocus>
            Cancel
          </button>
          <button type="button" className="danger" onClick={onConfirm}>
            Suspend account
          </button>
        </div>
      </div>
    </dialog>
  );
}

function CreateUserDialog({ onCreate, onClose }: { onCreate: (user: NewUser) => Promise<boolean>; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [form, setForm] = useState<NewUser>({ email: "", displayName: "", role: "END_USER", password: "" });
  const [showPassword, setShowPassword] = useState(false);
  const [created, setCreated] = useState<NewUser | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => dialog.current?.showModal(), []);

  const set = <K extends keyof NewUser>(key: K, value: NewUser[K]) => setForm((prev) => ({ ...prev, [key]: value }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (await onCreate(form)) setCreated(form);
    } catch (err) {
      setError(errorText(err, "Could not create the account."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <dialog
      ref={dialog}
      className="step-up-dialog create-user-dialog"
      aria-labelledby="create-user-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
    >
      {created ? (
        <div className="stack">
          <h2 id="create-user-title">Account created</h2>
          <p className="hint">
            Give {created.displayName} their password now: it isn't stored anywhere it can be read back, so this is the only time it's shown.
            {created.role !== "END_USER" && " Their first sign-in with it will make them set up an authenticator app before anything else."}
          </p>
          <div className="handover" aria-label="New account's sign-in details">
            <div>{created.email}</div>
            <code>{created.password}</code>
          </div>
          <div className="row end">
            <button
              type="button"
              onClick={async () => {
                await navigator.clipboard.writeText(created.password);
                setCopied(true);
              }}
            >
              {copied ? "Copied" : "Copy password"}
            </button>
            <button type="button" className="primary" onClick={onClose} autoFocus>
              Done
            </button>
          </div>
        </div>
      ) : (
        <form onSubmit={submit} className="stack">
          <h2 id="create-user-title">Create a user</h2>
          <p className="hint">They'll sign in with the password you set here.</p>
          {error && (
            <div className="error-box" role="alert">
              {error}
            </div>
          )}
          <div>
            <label htmlFor="new-user-name">Full name</label>
            <input id="new-user-name" type="text" value={form.displayName} onChange={(e) => set("displayName", e.target.value)} required autoFocus />
          </div>
          <div>
            <label htmlFor="new-user-email">Email</label>
            <input id="new-user-email" type="email" value={form.email} onChange={(e) => set("email", e.target.value)} required />
          </div>
          <div>
            <label htmlFor="new-user-role">Role</label>
            <select id="new-user-role" value={form.role} onChange={(e) => set("role", e.target.value as RoleName)}>
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABEL[r]}
                </option>
              ))}
            </select>
            {form.role !== "END_USER" && <p className="hint">Admin roles must set up an authenticator app at their first sign-in.</p>}
          </div>
          <div>
            <label htmlFor="new-user-password">Initial password</label>
            <div className="row password-field">
              <input
                id="new-user-password"
                type={showPassword ? "text" : "password"}
                value={form.password}
                onChange={(e) => set("password", e.target.value)}
                minLength={12}
                maxLength={200}
                autoComplete="new-password"
                required
              />
              <button type="button" className="sm" onClick={() => setShowPassword((v) => !v)}>
                {showPassword ? "Hide" : "Show"}
              </button>
              <button
                type="button"
                className="sm"
                onClick={() => {
                  set("password", generatePassword());
                  setShowPassword(true);
                }}
              >
                Generate
              </button>
            </div>
            <p className="hint">At least 12 characters.</p>
          </div>
          <div className="row end">
            <button type="button" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button type="submit" className="primary" disabled={busy}>
              {busy && <Spinner />}
              Create account
            </button>
          </div>
        </form>
      )}
    </dialog>
  );
}
