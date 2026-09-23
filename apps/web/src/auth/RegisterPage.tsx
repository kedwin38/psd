import { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { register, registerPasskey, loginWithPasskey } from "../lib/auth-api";
import { useAuth } from "../lib/auth-context";
import { ApiError } from "../lib/api";

export function RegisterPage() {
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<"form" | "passkey">("form");
  const navigate = useNavigate();
  const { setUser } = useAuth();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await register(email, displayName);
      setStep("passkey");
      await registerPasskey(email, navigator.userAgent.slice(0, 60));
      const user = await loginWithPasskey(email);
      setUser(user);
      navigate("/");
    } catch (err) {
      setError(err instanceof ApiError ? (err.detail ?? err.title) : "Something went wrong.");
      setStep("form");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="center-page">
      <div className="card auth-card">
        <h1>Create your account</h1>
        <p className="subtitle">
          Registration adds a passkey as your credential — no password required. Your device's fingerprint, face, or
          PIN unlocks it.
        </p>
        {error && <div className="error-box">{error}</div>}
        <form onSubmit={submit} className="stack">
          <div>
            <label htmlFor="displayName">Full name</label>
            <input id="displayName" type="text" value={displayName} onChange={(e) => setDisplayName(e.target.value)} required />
          </div>
          <div>
            <label htmlFor="email">Email</label>
            <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </div>
          <button type="submit" className="primary" disabled={busy} style={{ marginTop: 8 }}>
            {step === "passkey" ? "Confirm on this device…" : busy ? "Creating account…" : "Create account with a passkey"}
          </button>
        </form>
        <p className="hint" style={{ marginTop: 16 }}>
          Already have an account? <Link to="/login">Sign in</Link>
        </p>
      </div>
    </div>
  );
}
