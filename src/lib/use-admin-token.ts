"use client";

import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "kalshi-predictor:admin-token";

/**
 * Read/write the admin token from `localStorage`.
 *
 * The token must reach server actions, but Next.js server-action RPC
 * does not forward custom request headers from the browser. So the
 * client component reads the token from localStorage and passes it as
 * an explicit argument to each action. The action falls back to the
 * `x-admin-token` header for API-route callers (curl, tests, etc.).
 *
 * Returns `null` during SSR / first paint to avoid hydration mismatch.
 */
export function useAdminToken(): {
  token: string | null;
  ready: boolean;
  setToken: (next: string) => void;
  clear: () => void;
} {
  const [token, setTokenState] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (typeof stored === "string" && stored.length > 0) {
        setTokenState(stored);
      }
    } catch {
      // localStorage can throw in private mode or when disabled; the
      // user can still paste the token each time via the banner.
    }
    setReady(true);
  }, []);

  const setToken = useCallback((next: string) => {
    const trimmed = next.trim();
    setTokenState(trimmed.length > 0 ? trimmed : null);
    try {
      if (trimmed.length > 0) {
        window.localStorage.setItem(STORAGE_KEY, trimmed);
      } else {
        window.localStorage.removeItem(STORAGE_KEY);
      }
    } catch {
      // see comment above
    }
  }, []);

  const clear = useCallback(() => {
    setTokenState(null);
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      // see comment above
    }
  }, []);

  return { token, ready, setToken, clear };
}
