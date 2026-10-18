"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { syncSportsAction, syncKalshiAction, importKalshiBetsAction } from "@/lib/actions";
import { useAdminToken } from "@/lib/use-admin-token";

export function AdminControls() {
  const [isPending, startTransition] = useTransition();
  const { token, ready } = useAdminToken();

  function run(label: string, action: () => Promise<{ ok: boolean; error?: string }>) {
    startTransition(async () => {
      if (!token) {
        toast.error(`${label} failed`, {
          description: "Admin token not set. Paste ADMIN_TOKEN in the banner above.",
        });
        return;
      }
      const result = await action();
      if (result.ok) {
        const d = (result as { data?: { bets?: number; created?: number; updated?: number; adopted?: number; skipped?: number } }).data;
        toast.success(
          `${label} complete`,
          d?.bets !== undefined
            ? {
                description:
                  `${d.bets} bet${d.bets === 1 ? "" : "s"} found: ${d.created} new, ${d.updated} refreshed` +
                  (d.adopted ? `, ${d.adopted} matched to parlays you built` : "") +
                  (d.skipped ? `, ${d.skipped} skipped` : ""),
              }
            : undefined
        );
      } else {
        toast.error(`${label} failed`, { description: result.error });
      }
    });
  }

  // While the hook is hydrating, render disabled buttons. The banner
  // also gates on `ready` so the user gets one consistent state.
  const disabled = isPending || !ready || !token;

  return (
    <div className="flex flex-wrap gap-2">
      <Button
        variant="outline"
        size="sm"
        disabled={disabled}
        onClick={() => run("Sports sync", () => syncSportsAction(undefined, token))}
      >
        Sync games
      </Button>
      <Button
        variant="outline"
        size="sm"
        disabled={disabled}
        onClick={() => run("Kalshi sync", () => syncKalshiAction(undefined, token))}
      >
        Sync Kalshi markets
      </Button>
      <Button
        variant="outline"
        size="sm"
        disabled={disabled}
        onClick={() => run("Kalshi import", () => importKalshiBetsAction(token))}
      >
        Import my Kalshi bets
      </Button>
    </div>
  );
}
