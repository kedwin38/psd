import { useEffect, useRef, useState, type ReactNode } from "react";
import { ApiError } from "../lib/api";
import { stepUpMethods, stepUpWithPasskey, stepUpWithTotp } from "../lib/auth-api";
import { Spinner } from "./workspace";

type Settle = (stepUpToken: string | null) => void;

/**
 * Re-authenticates before a sensitive action: with a passkey when the account has one, otherwise with an
 * authenticator code typed into a dialog. `stepUp` resolves to the step-up token, or null if the admin cancels.
 */
export function useStepUp(): { stepUp: () => Promise<string | null>; dialog: ReactNode } {
  const [settle, setSettle] = useState<Settle | null>(null);

  const stepUp = async () => {
    const methods = await stepUpMethods();
    if (methods.includes("passkey") || !methods.includes("totp")) return stepUpWithPasskey();
    return new Promise<string | null>((resolve) => setSettle(() => resolve));
  };

  const done: Settle = (stepUpToken) => {
    settle?.(stepUpToken);
    setSettle(null);
  };

  return { stepUp, dialog: settle && <TotpStepUpDialog onDone={done} /> };
}

function TotpStepUpDialog({ onDone }: { onDone: Settle }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => dialog.current?.showModal(), []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      onDone(await stepUpWithTotp(code.trim()));
    } catch (err) {
      setError(err instanceof ApiError ? (err.detail ?? err.title) : "Could not check the code.");
      setCode("");
      setBusy(false);
    }
  };

  return (
    <dialog
      ref={dialog}
      className="step-up-dialog"
      aria-labelledby="step-up-title"
      onCancel={(e) => {
        e.preventDefault();
        onDone(null);
      }}
    >
      <form onSubmit={submit} className="stack">
        <h2 id="step-up-title">Confirm it's you</h2>
        <p className="hint">Enter the 6-digit code from your authenticator app, or one of your recovery codes.</p>
        {error && (
          <div className="error-box" role="alert">
            {error}
          </div>
        )}
        <div>
          <label htmlFor="step-up-code">Authenticator code</label>
          <input
            id="step-up-code"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            required
            autoFocus
          />
        </div>
        <div className="row end">
          <button type="button" onClick={() => onDone(null)} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy}>
            {busy && <Spinner />}
            Confirm
          </button>
        </div>
      </form>
    </dialog>
  );
}
