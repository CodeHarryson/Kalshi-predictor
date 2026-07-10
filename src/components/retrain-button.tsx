"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { retrainAction } from "@/lib/actions";
import type { League } from "@/generated/prisma/enums";

export function RetrainButton({ league }: { league: League }) {
  const [isPending, startTransition] = useTransition();

  function retrain() {
    startTransition(async () => {
      const result = await retrainAction(league);
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
    <Button variant="outline" size="sm" disabled={isPending} onClick={retrain}>
      Retrain {league}
    </Button>
  );
}
