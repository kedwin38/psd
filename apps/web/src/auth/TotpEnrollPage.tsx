import { useState } from "react";
import { setPassword } from "../lib/auth-api";
import { ApiError } from "../lib/api";
import { useStepUp } from "../components/StepUpDialog";
import { RecoveryCodes, TotpEnrollment } from "./TotpEnrollment";

/**
 * Changes the account's own password at any time (not just during first-time setup), for anyone
 * signed in — admins included. Re-verifies with a step-up challenge first, same as any other
 * sensitive account change (spec §12); the API itself would reject a change without one anyway,
 * this just gets that confirmation up front instead of a failed submit.
 */
function ChangePasswordCard() {
  const { stepUp, dialog: stepUpDialog } = useStepUp();
  const [password, setPasswordValue] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(false);
    if (password !== confirm) {
      setError("Those passwords don't match.");
      return;
    }
    setBusy(true);
    try {
      const stepUpToken = await stepUp();
      if (!stepUpToken) return;
      await setPassword(password, stepUpToken);
      setPasswordValue("");
      setConfirm("");
      setSuccess(true);
    } catch (err) {
      setError(err instanceof ApiError ? (err.detail ?? err.title) : "Could not change your password.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <h2>Change your password</h2>
      <p className="hint">You'll be asked to confirm it's you first.</p>
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}
      {success && <div className="success-box">Your password was changed.</div>}
      <form onSubmit={submit} className="stack">
        <label htmlFor="change-password-new">New password</label>
        <input
          id="change-password-new"
          type="password"
          value={password}
          onChange={(e) => setPasswordValue(e.target.value)}
          minLength={12}
          autoComplete="new-password"
          required
        />
        <label htmlFor="change-password-confirm">Confirm new password</label>
        <input
          id="change-password-confirm"
          type="password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          minLength={12}
          autoComplete="new-password"
          required
        />
        <button type="submit" className="primary" disabled={busy}>
          Change password
        </button>
      </form>
      {stepUpDialog}
    </div>
  );
}

export function TotpEnrollPage() {
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [password, setPasswordValue] = useState("");
  const [passwordSaved, setPasswordSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const savePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await setPassword(password);
      setPasswordSaved(true);
    } catch (err) {
      setError(err instanceof ApiError ? (err.detail ?? err.title) : "Could not set password.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack" style={{ maxWidth: 480 }}>
      <h1>Security settings</h1>
      <p className="subtitle">
        Your passkey is already phishing-resistant MFA. Optionally enroll an authenticator app (TOTP) as a fallback
        for devices without a platform authenticator (spec §12), with a password to go with it — signing in with that
        password then always asks for a code from the app too.
      </p>
      {error && <div className="error-box">{error}</div>}

      <ChangePasswordCard />

      {!recoveryCodes && (
        <div className="card">
          <h2>1. Enroll an authenticator app</h2>
          <TotpEnrollment onEnrolled={setRecoveryCodes} />
        </div>
      )}

      {recoveryCodes && (
        <div className="card">
          <RecoveryCodes codes={recoveryCodes} />
        </div>
      )}

      {recoveryCodes && !passwordSaved && (
        <div className="card">
          <h2>2. Set a password</h2>
          <p className="hint">Required for the password+TOTP fallback login path (12+ characters).</p>
          <form onSubmit={savePassword} className="stack">
            <label htmlFor="new-password">Password</label>
            <input id="new-password" type="password" value={password} onChange={(e) => setPasswordValue(e.target.value)} minLength={12} required />
            <button type="submit" className="primary" disabled={busy}>
              Save password
            </button>
          </form>
        </div>
      )}

      {passwordSaved && <div className="success-box">Fallback login is ready: password + authenticator code.</div>}
    </div>
  );
}
