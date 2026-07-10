"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { syncSportsAction, syncKalshiAction } from "@/lib/actions";

export function AdminControls() {
  const [isPending, startTransition] = useTransition();

  function run(label: string, action: () => Promise<{ ok: boolean; error?: string }>) {
    startTransition(async () => {
      const result = await action();
      if (result.ok) {
        toast.success(`${label} complete`);
      } else {
        toast.error(`${label} failed`, { description: result.error });
      }
    });
  }

  return (
    <div className="flex flex-wrap gap-2">
      <Button
        variant="outline"
        size="sm"
        disabled={isPending}
        onClick={() => run("Sports sync", () => syncSportsAction())}
      >
        Sync games
      </Button>
      <Button
        variant="outline"
        size="sm"
        disabled={isPending}
        onClick={() => run("Kalshi sync", () => syncKalshiAction())}
      >
        Sync Kalshi markets
      </Button>
    </div>
  );
}
