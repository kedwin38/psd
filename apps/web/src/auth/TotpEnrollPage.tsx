import { useState } from "react";
import { setPassword } from "../lib/auth-api";
import { ApiError } from "../lib/api";
import { RecoveryCodes, TotpEnrollment } from "./TotpEnrollment";

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
