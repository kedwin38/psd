import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api, setMfaSetupRequiredHandler, setUnauthorizedHandler, tryRefresh } from "./api";
import type { AuthenticatedUser } from "./types";

interface AuthContextValue {
  user: AuthenticatedUser | null;
  loading: boolean;
  refreshUser: () => Promise<void>;
  setUser: (user: AuthenticatedUser | null) => void;
  signOut: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthenticatedUser | null>(null);
  const [loading, setLoading] = useState(true);

  const refreshUser = async () => {
    const token = await tryRefresh();
    if (!token) {
      setUser(null);
      return;
    }
    try {
      const me = await api.get<AuthenticatedUser>("/auth/me");
      setUser(me);
    } catch {
      setUser(null);
    }
  };

  useEffect(() => {
    setUnauthorizedHandler(() => setUser(null));
    // /auth/me stays answerable during a forced enrollment and says so, which swaps the app for the setup screen.
    setMfaSetupRequiredHandler(() => {
      api.get<AuthenticatedUser>("/auth/me").then(setUser, () => undefined);
    });
    refreshUser().finally(() => setLoading(false));
    return () => {
      setUnauthorizedHandler(null);
      setMfaSetupRequiredHandler(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const signOut = () => setUser(null);

  return <AuthContext.Provider value={{ user, loading, refreshUser, setUser, signOut }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
