"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useAdminToken } from "@/lib/use-admin-token";

export interface ComboLeg {
  gameId: string | null;
  kalshiMarketId: string;
  description: string;
  side: "YES" | "NO";
  legKind: string;
  predictedProbability: number;
  marketImpliedProbability: number;
  features: Record<string, number>;
}

/**
 * Saves a recommended combo as a parlay (the same POST the builder uses) and
 * confirms, instead of just linking to the builder. Once saved the button
 * locks, so a second click can't create a duplicate.
 */
export function BuildComboButton({ legs }: { legs: ComboLeg[] }) {
  const router = useRouter();
  const { token, ready } = useAdminToken();
  const [pending, startTransition] = useTransition();
  const [built, setBuilt] = useState(false);

  function build() {
    if (!token) {
      toast.error("Could not build parlay", {
        description: "Admin token not set. Paste ADMIN_TOKEN in the banner at the top of the dashboard.",
      });
      return;
    }
    startTransition(async () => {
      try {
        const res = await fetch("/api/parlays", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-admin-token": token },
          body: JSON.stringify({ legs, source: "suggestion" }),
        });
        if (!res.ok) {
          const detail = await res.json().catch(() => null);
          throw new Error(detail?.error ?? `Request failed (${res.status})`);
        }
        setBuilt(true);
        toast.success("Parlay built", {
          description: `${legs.length} legs saved to History. Place it on Kalshi, then import your bets to track the result.`,
          action: { label: "View history", onClick: () => router.push("/history") },
        });
        router.refresh();
      } catch (err) {
        toast.error("Could not build parlay", {
          description: err instanceof Error ? err.message : undefined,
        });
      }
    });
  }

  return (
    <Button size="sm" variant="outline" disabled={!ready || pending || built} onClick={build}>
      {built ? "Built ✓" : pending ? "Building…" : "Build"}
    </Button>
  );
}
