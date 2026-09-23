import { useState } from "react";
import QRCode from "qrcode";
import { enrollTotpOptions, enrollTotpVerify, setPassword } from "../lib/auth-api";
import { ApiError } from "../lib/api";

export function TotpEnrollPage() {
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [password, setPasswordValue] = useState("");
  const [passwordSaved, setPasswordSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const startEnroll = async () => {
    setError(null);
    setBusy(true);
    try {
      const { otpauthUrl, secretBase32 } = await enrollTotpOptions();
      setSecret(secretBase32);
      setQrDataUrl(await QRCode.toDataURL(otpauthUrl, { margin: 1, width: 220 }));
    } catch (err) {
      setError(err instanceof ApiError ? (err.detail ?? err.title) : "Could not start enrollment.");
    } finally {
      setBusy(false);
    }
  };

  const confirmEnroll = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const { recoveryCodes } = await enrollTotpVerify(code);
      setRecoveryCodes(recoveryCodes);
    } catch (err) {
      setError(err instanceof ApiError ? (err.detail ?? err.title) : "Invalid code.");
    } finally {
      setBusy(false);
    }
  };

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
        for devices without a platform authenticator (spec §12) — this also requires a password, since the password
        login path always demands a second factor.
      </p>
      {error && <div className="error-box">{error}</div>}

      {!recoveryCodes && (
        <div className="card">
          <h2>1. Enroll an authenticator app</h2>
          {!qrDataUrl ? (
            <button className="primary" onClick={startEnroll} disabled={busy}>
              Start TOTP enrollment
            </button>
          ) : (
            <form onSubmit={confirmEnroll} className="stack">
              <img src={qrDataUrl} alt="TOTP QR code" style={{ borderRadius: 8, alignSelf: "flex-start" }} />
              <p className="hint">Or enter this secret manually: {secret}</p>
              <label htmlFor="totp-enroll-code">6-digit code from your app</label>
              <input id="totp-enroll-code" type="text" inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} required autoFocus />
              <button type="submit" className="primary" disabled={busy}>
                Confirm
              </button>
            </form>
          )}
        </div>
      )}

      {recoveryCodes && (
        <div className="card">
          <h2>Save your recovery codes</h2>
          <p className="hint">Each code can be used once if you lose access to your authenticator app.</p>
          <pre style={{ background: "var(--bg)", padding: 12, borderRadius: 8, fontSize: 13 }}>{recoveryCodes.join("\n")}</pre>
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
