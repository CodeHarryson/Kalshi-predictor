"use client";

import { useAdminToken } from "@/lib/use-admin-token";
import { AdminTokenBanner } from "@/components/admin-token-banner";
import { AdminControls } from "@/components/admin-controls";

/**
 * Client-side wrapper that owns the admin-token hook and renders the
 * banner + buttons together. The page (server component) mounts this
 * once and stays free of client-side state.
 */
export function AdminTokenGate() {
  const { token, ready, setToken } = useAdminToken();

  return (
    <div className="flex flex-col gap-3">
      <AdminTokenBanner token={token} ready={ready} onSave={setToken} />
      <AdminControls />
    </div>
  );
}
