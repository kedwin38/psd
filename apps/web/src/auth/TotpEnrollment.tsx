import { useState } from "react";
import QRCode from "qrcode";
import { enrollTotpOptions, enrollTotpVerify } from "../lib/auth-api";
import { ApiError } from "../lib/api";

/** Scan-and-confirm enrollment of an authenticator app; hands over the one-time recovery codes once a code checks out. */
export function TotpEnrollment({ onEnrolled }: { onEnrolled: (recoveryCodes: string[]) => void }) {
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [code, setCode] = useState("");
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
      onEnrolled(recoveryCodes);
    } catch (err) {
      setError(err instanceof ApiError ? (err.detail ?? err.title) : "Invalid code.");
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      {error && <div className="error-box">{error}</div>}
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
  );
}

export function RecoveryCodes({ codes }: { codes: string[] }) {
  return (
    <>
      <h2>Save your recovery codes</h2>
      <p className="hint">Each code can be used once if you lose access to your authenticator app.</p>
      <pre style={{ background: "var(--bg)", padding: 12, borderRadius: 8, fontSize: 13 }}>{codes.join("\n")}</pre>
    </>
  );
}
