import { Badge } from "@/components/ui/badge";
import type { ParlayStatus, LegOutcome } from "@/generated/prisma/enums";

const VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  WON: "default",
  LOST: "destructive",
  PUSH: "secondary",
  PENDING: "outline",
};

export function StatusBadge({ status }: { status: ParlayStatus | LegOutcome }) {
  return <Badge variant={VARIANT[status] ?? "outline"}>{status}</Badge>;
}
