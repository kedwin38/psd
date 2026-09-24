import { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { loginWithPasskey, passwordLoginStart, passwordLoginVerifyTotp } from "../lib/auth-api";
import { useAuth } from "../lib/auth-context";
import { ApiError } from "../lib/api";
import { BrandMark } from "../components/workspace";

export function LoginPage() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showFallback, setShowFallback] = useState(false);
  const [password, setPassword] = useState("");
  const [pendingToken, setPendingToken] = useState<string | null>(null);
  const [totpCode, setTotpCode] = useState("");
  const navigate = useNavigate();
  const { setUser } = useAuth();

  const withPasskey = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const user = await loginWithPasskey(email);
      setUser(user);
      navigate("/");
    } catch (err) {
      setError(err instanceof ApiError ? (err.detail ?? err.title) : "Sign-in failed.");
    } finally {
      setBusy(false);
    }
  };

  const startPasswordLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const { pendingToken } = await passwordLoginStart(email, password);
      setPendingToken(pendingToken);
    } catch (err) {
      setError(err instanceof ApiError ? (err.detail ?? err.title) : "Sign-in failed.");
    } finally {
      setBusy(false);
    }
  };

  const finishPasswordLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pendingToken) return;
    setError(null);
    setBusy(true);
    try {
      const user = await passwordLoginVerifyTotp(pendingToken, totpCode);
      setUser(user);
      navigate("/");
    } catch (err) {
      setError(err instanceof ApiError ? (err.detail ?? err.title) : "Invalid code.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="center-page">
      <div className="card auth-card">
        <div className="brand">
          <BrandMark />
          PSD Template Studio
        </div>
        <h1>Sign in</h1>
        <p className="subtitle">Passkeys are the primary, phishing-resistant way in — no password to steal.</p>
        {error && <div className="error-box">{error}</div>}

        {!showFallback && (
          <>
            <form onSubmit={withPasskey} className="stack">
              <div>
                <label htmlFor="email-passkey">Email</label>
                <input id="email-passkey" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
              </div>
              <button type="submit" className="primary" disabled={busy} style={{ marginTop: 8 }}>
                {busy ? "Waiting for passkey…" : "Sign in with passkey"}
              </button>
            </form>
            <p className="hint" style={{ marginTop: 14 }}>
              <button className="link" onClick={() => setShowFallback(true)}>
                Use password + authenticator code instead
              </button>
            </p>
          </>
        )}

        {showFallback && !pendingToken && (
          <form onSubmit={startPasswordLogin} className="stack">
            <div>
              <label htmlFor="email-password">Email</label>
              <input id="email-password" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </div>
            <div>
              <label htmlFor="password">Password</label>
              <input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </div>
            <p className="hint">This path requires TOTP to already be enrolled — passwords alone are never enough.</p>
            <button type="submit" className="primary" disabled={busy}>
              Continue
            </button>
            <button type="button" className="link" onClick={() => setShowFallback(false)}>
              Back to passkey sign-in
            </button>
          </form>
        )}

        {pendingToken && (
          <form onSubmit={finishPasswordLogin} className="stack">
            <div>
              <label htmlFor="totp-code">6-digit authenticator code</label>
              <input
                id="totp-code"
                type="text"
                inputMode="numeric"
                value={totpCode}
                onChange={(e) => setTotpCode(e.target.value)}
                required
                autoFocus
              />
            </div>
            <button type="submit" className="primary" disabled={busy}>
              Verify and sign in
            </button>
          </form>
        )}

        <p className="hint" style={{ marginTop: 16 }}>
          New here? <Link to="/register">Create an account</Link>
        </p>
      </div>
    </div>
  );
}
