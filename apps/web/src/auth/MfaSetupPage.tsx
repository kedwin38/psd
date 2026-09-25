import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { logout } from "../lib/auth-api";
import { useAuth } from "../lib/auth-context";
import type { AuthenticatedUser } from "../lib/types";
import { BrandMark } from "../components/workspace";
import { RecoveryCodes, TotpEnrollment } from "./TotpEnrollment";

function useSecondsLeft(deadline: string | null): number | null {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!deadline) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [deadline]);
  return deadline ? Math.max(0, Math.ceil((Date.parse(deadline) - now) / 1000)) : null;
}

const minutesSeconds = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

/**
 * Shown in place of the whole app while the account owes a TOTP enrollment: an admin role is never usable on a password
 * alone. The API holds every other route meanwhile, so this screen is the only thing that would work anyway.
 */
export function MfaSetupPage() {
  const { user, setUser, signOut } = useAuth();
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const secondsLeft = useSecondsLeft(user?.mfaSetupDeadline ?? null);

  return (
    <div className="center-page">
      <div className="card auth-card">
        <div className="brand">
          <BrandMark />
          PSD Template Studio
        </div>
        <h1>Set up your authenticator app</h1>
        {!recoveryCodes ? (
          <>
            <p className="subtitle">
              Your account has admin access, which always needs a second factor. Add an authenticator app now — until
              you do, nothing else in PSD Template Studio will open for {user?.email}.
            </p>
            {secondsLeft !== null &&
              (secondsLeft > 0 ? (
                <div className="warning-box" role="status">
                  Set this up within {minutesSeconds(secondsLeft)}.
                </div>
              ) : (
                <div className="error-box" role="alert">
                  Your 15 minutes to set this up have passed. Your account stays blocked until you finish.
                </div>
              ))}
            <TotpEnrollment onEnrolled={setRecoveryCodes} />
          </>
        ) : (
          <div className="stack">
            <RecoveryCodes codes={recoveryCodes} />
            <button className="primary" onClick={async () => setUser(await api.get<AuthenticatedUser>("/auth/me"))}>
              Continue to PSD Template Studio
            </button>
          </div>
        )}
        <p className="hint" style={{ marginTop: 16 }}>
          <button
            className="link"
            onClick={async () => {
              await logout();
              signOut();
            }}
          >
            Sign out
          </button>
        </p>
      </div>
    </div>
  );
}
