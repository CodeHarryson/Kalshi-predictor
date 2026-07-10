import { db } from "@/lib/db";
import { StatusBadge } from "@/components/status-badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export const dynamic = "force-dynamic";

function formatDate(date: Date) {
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default async function HistoryPage() {
  const parlays = await db.parlay.findMany({
    include: { legs: true },
    orderBy: { createdAt: "desc" },
  });

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">History</h1>
        <p className="text-sm text-muted-foreground">
          Every parlay you have built, with per-leg outcomes.
        </p>
      </div>

      {parlays.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            No parlays yet.
          </CardContent>
        </Card>
      ) : (
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Created</TableHead>
                <TableHead>Legs</TableHead>
                <TableHead>Combined</TableHead>
                <TableHead>Stake</TableHead>
                <TableHead className="text-right">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {parlays.map((parlay) => (
                <TableRow key={parlay.id} className="align-top">
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
                    <StatusBadge status={parlay.status} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
    </div>
  );
}
