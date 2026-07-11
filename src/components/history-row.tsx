"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { useAdminToken } from "@/lib/use-admin-token";
import { markParlayOutcomeAction } from "@/lib/actions";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { TableCell, TableRow } from "@/components/ui/table";
import type { LegOutcome, MarketSide, ParlayStatus } from "@/generated/prisma/enums";

export interface HistoryRowParlay {
  id: string;
  createdAt: Date;
  combinedProbability: number | null;
  stake: number | null;
  status: ParlayStatus;
  legs: {
    id: string;
    description: string;
    side: MarketSide;
    predictedProbability: number;
    actualOutcome: LegOutcome;
  }[];
}

interface HistoryRowProps {
  parlay: HistoryRowParlay;
}

function formatDate(date: Date) {
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function HistoryRow({ parlay }: HistoryRowProps) {
  const { token, ready } = useAdminToken();
  const [pending, startTransition] = useTransition();
  const canMark = ready && !!token && parlay.status === "PENDING";

  function mark(outcome: "WON" | "LOST") {
    startTransition(async () => {
      const r = await markParlayOutcomeAction(parlay.id, outcome, token);
      if (r.ok) {
        toast.success(`Marked ${outcome.toLowerCase()}`);
      } else {
        toast.error("Could not mark outcome", { description: r.error });
      }
    });
  }

  return (
    <TableRow className="align-top">
      <TableCell>{formatDate(parlay.createdAt)}</TableCell>
      <TableCell className="max-w-md whitespace-normal">
        <ul className="flex flex-col gap-1">
          {parlay.legs.map((leg) => (
            <li
              key={leg.id}
              className="flex items-center justify-between gap-2"
            >
              <span className="truncate">
                {leg.description}
                <span className="ml-1 text-muted-foreground">
                  ({leg.side} {(leg.predictedProbability * 100).toFixed(0)}%)
                </span>
              </span>
              <StatusBadge status={leg.actualOutcome} />
            </li>
          ))}
        </ul>
      </TableCell>
      <TableCell>
        {parlay.combinedProbability != null
          ? `${(parlay.combinedProbability * 100).toFixed(1)}%`
          : "—"}
      </TableCell>
      <TableCell>{parlay.stake != null ? `$${parlay.stake}` : "—"}</TableCell>
      <TableCell className="text-right">
        {canMark ? (
          <div className="flex justify-end gap-1">
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => mark("WON")}
            >
              Won
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => mark("LOST")}
            >
              Lost
            </Button>
          </div>
        ) : (
          <StatusBadge status={parlay.status} />
        )}
      </TableCell>
    </TableRow>
  );
}
