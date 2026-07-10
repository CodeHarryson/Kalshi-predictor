"use client";

import { useEffect, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { fetchCalibrationAction } from "@/lib/actions";
import type { League } from "@/generated/prisma/enums";

interface Bucket {
  label?: string;
  min?: number;
  max?: number;
  count?: number;
  avgPredicted?: number;
  actualWinRate?: number;
}

interface Calibration {
  brierScore?: number | null;
  sampleSize?: number;
  buckets?: Bucket[];
}

function pct(n: number | undefined) {
  return typeof n === "number" ? `${(n * 100).toFixed(0)}%` : "—";
}

interface CalibrationPanelProps {
  league: League;
  initialData: Calibration | null;
}

export function CalibrationPanel({ league, initialData }: CalibrationPanelProps) {
  const [data, setData] = useState<Calibration | null>(initialData);
  const [loading, setLoading] = useState(!initialData);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    fetchCalibrationAction(league)
      .then((result) => {
        if (!active) return;
        if (!result.ok) throw new Error(result.error ?? "Request failed");
        setData(result.data ?? null);
      })
      .catch((err) => active && setError(err instanceof Error ? err.message : "Error"))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [league]);

  if (loading) return <Skeleton className="h-24 w-full" />;
  if (error)
    return <p className="text-sm text-muted-foreground">Calibration unavailable: {error}</p>;

  const buckets = Array.isArray(data?.buckets) ? data!.buckets : [];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-6 text-sm">
        <div>
          <span className="text-muted-foreground">Brier score: </span>
          <span className="font-medium">
            {typeof data?.brierScore === "number" ? data.brierScore.toFixed(4) : "—"}
          </span>
        </div>
        {typeof data?.sampleSize === "number" && (
          <div>
            <span className="text-muted-foreground">Samples: </span>
            <span className="font-medium">{data.sampleSize}</span>
          </div>
        )}
      </div>

      {buckets.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No settled outcomes yet — calibration builds up as parlays settle.
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Bucket</TableHead>
              <TableHead className="text-right">Predicted</TableHead>
              <TableHead className="text-right">Actual</TableHead>
              <TableHead className="text-right">n</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {buckets.map((b, i) => (
              <TableRow key={i}>
                <TableCell>
                  {b.label ??
                    (b.min != null && b.max != null
                      ? `${pct(b.min)}–${pct(b.max)}`
                      : `#${i + 1}`)}
                </TableCell>
                <TableCell className="text-right">{pct(b.avgPredicted)}</TableCell>
                <TableCell className="text-right">{pct(b.actualWinRate)}</TableCell>
                <TableCell className="text-right">{b.count ?? "—"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
