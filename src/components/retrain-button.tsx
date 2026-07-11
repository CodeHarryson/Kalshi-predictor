"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { retrainAction } from "@/lib/actions";
import { useAdminToken } from "@/lib/use-admin-token";
import type { League } from "@/generated/prisma/enums";

export function RetrainButton({ league }: { league: League }) {
  const [isPending, startTransition] = useTransition();
  const { token, ready } = useAdminToken();

  function retrain() {
    startTransition(async () => {
      if (!token) {
        toast.error("Retrain failed", {
          description: "Admin token not set. Paste ADMIN_TOKEN in the banner above.",
        });
        return;
      }
      const result = await retrainAction(league, token);
      if (!result.ok) {
        toast.error("Retrain failed", { description: result.error });
        return;
      }
      if (result.data?.trained) {
        toast.success("Model retrained", {
          description: `${result.data.sampleSize} settled legs used.`,
        });
      } else {
        toast.info("Not enough data to retrain", {
          description: `${result.data?.sampleSize ?? 0} settled legs so far.`,
        });
      }
    });
  }

  return (
    <Button
      variant="outline"
      size="sm"
      disabled={isPending || !ready || !token}
      onClick={retrain}
    >
      Retrain {league}
    </Button>
  );
}
