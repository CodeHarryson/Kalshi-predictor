import { db } from "@/lib/db";
import { HistoryRow } from "@/components/history-row";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export const dynamic = "force-dynamic";

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
                <HistoryRow
                  key={parlay.id}
                  parlay={{
                    id: parlay.id,
                    createdAt: parlay.createdAt,
                    combinedProbability: parlay.combinedProbability,
                    stake: parlay.stake,
                    status: parlay.status,
                    legs: parlay.legs.map((leg) => ({
                      id: leg.id,
                      description: leg.description,
                      side: leg.side,
                      predictedProbability: leg.predictedProbability,
                      actualOutcome: leg.actualOutcome,
                    })),
                  }}
                />
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
    </div>
  );
}
