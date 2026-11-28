"use client";

import { useEffect, useState } from "react";

/**
 * `unavailable` means the check could not answer (5xx, network failure, no
 * session lookup). A definitive "not an admin" is `ok` + isAdmin false; the
 * two were conflated, so a blip redirected admins home with no explanation.
 */
export type AdminCheckStatus = "ok" | "unavailable";

interface UseAdminResult {
  isAdmin: boolean;
  loading: boolean;
  status: AdminCheckStatus;
}

/**
 * Check if the current user is an admin.
 *
 * Eleven components mount this hook (sidebar, snapshot alert, admin pages,
 * profile dialog), and each used to fire its own request on mount: /dashboard
 * alone issued two identical `/api/admin/check` calls, and each one costs an
 * `/api/auth` read plus a `users.getById` RPC. A module-level promise
 * collapses concurrent mounts into one request, and the result is reused for
 * a short window so navigating between admin pages does not refetch.
 *
 * Staleness is bounded and harmless: the API still returns 403 on every
 * admin route, so the cached value only decides whether the UI *offers* an
 * entry point. The cache is not user-keyed, but both sign-in and sign-out
 * go through `signOut({ callbackUrl })` / a full redirect, which reloads the
 * page and drops this module state; the 5-minute window only spans one
 * session in one tab.
 */
const CACHE_MS = 5 * 60 * 1000;

interface CacheState {
  isAdmin: boolean;
  at: number;
}

export interface AdminCheckState {
  status: AdminCheckStatus;
  isAdmin: boolean;
}

let cache: CacheState | null = null;
let inflight: Promise<AdminCheckState> | null = null;

async function fetchIsAdmin(): Promise<AdminCheckState> {
  try {
    const res = await fetch("/api/admin/check");
    // null = "could not confirm". A200 with { isAdmin: false } is the
    // authoritative denial; anything else is a transient failure.
    if (!res.ok) return { status: "unavailable", isAdmin: false };
    const json = (await res.json()) as { isAdmin: boolean };
    return { status: "ok", isAdmin: json.isAdmin };
  } catch {
    return { status: "unavailable", isAdmin: false };
  }
}

function loadIsAdminState(): Promise<AdminCheckState> {
  if (cache && Date.now() - cache.at < CACHE_MS) {
    return Promise.resolve({ status: "ok", isAdmin: cache.isAdmin });
  }
  inflight ??= fetchIsAdmin().then((state) => {
    // Caching a failure as `false` for 5 minutes logged admins out of the
    // admin UI on one network blip: the redirect home is a client-side
    // navigation, so the poisoned module cache kept hiding the sidebar
    // entries and re-redirecting every admin page with no message. Do not
    // store an unconfirmed answer — the next mount asks again.
    if (state.status === "ok") cache = { isAdmin: state.isAdmin, at: Date.now() };
    inflight = null;
    return state;
  });
  return inflight;
}

function loadIsAdmin(): Promise<boolean> {
  return loadIsAdminState().then((state) => state.isAdmin);
}

function resetAdminCache(): void {
  cache = null;
  inflight = null;
}

export function useAdmin(): UseAdminResult {
  const [isAdmin, setIsAdmin] = useState(false);
  const [status, setStatus] = useState<AdminCheckStatus>("ok");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    loadIsAdminState().then((state) => {
      if (!cancelled) {
        setIsAdmin(state.isAdmin);
        setStatus(state.status);
        setLoading(false);
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

  return { isAdmin, loading, status };
}

// ---------------------------------------------------------------------------
// Test-only helpers (not used in production code paths).
// ---------------------------------------------------------------------------

/** @internal Trigger a load mimicking the hook's guard. Test use only. */
export function __loadIsAdminForTests(): Promise<boolean> {
  return loadIsAdmin();
}

/** @internal Tri-state loader for tests that assert the unavailable branch. */
export function __loadIsAdminStateForTests(): Promise<AdminCheckState> {
  return loadIsAdminState();
}

/** @internal Drop the module-level cache. Test use only. */
export function __resetAdminCacheForTests(): void {
  resetAdminCache();
}
