"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { AdminTokenBanner } from "@/components/admin-token-banner";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { fetchSuggestionsAction } from "@/lib/actions";
import { useAdminToken } from "@/lib/use-admin-token";

interface Candidate {
  gameId: string | null;
  kalshiMarketId: string;
  description: string;
  side: "YES" | "NO";
  legKind: "GAME_WINNER" | "PLAYER_GOALS" | "TEAM_CORNERS";
  predictedProbability: number;
  marketImpliedProbability: number | null;
  edge: number;
  features: unknown;
}

interface BuilderClientProps {
  initialCandidates: Candidate[];
  initialLeague: string;
}

const LEAGUES = [
  { value: "NFL", label: "NFL" },
  { value: "NBA", label: "NBA" },
  { value: "CFB", label: "College Football" },
  { value: "EPL", label: "Premier League" },
  { value: "LALIGA", label: "La Liga" },
  { value: "WORLD_CUP", label: "World Cup" },
];

function pct(n: number | null | undefined) {
  return n != null ? `${(n * 100).toFixed(1)}%` : "—";
}

function legKey(c: Candidate) {
  return `${c.kalshiMarketId}:${c.side}`;
}

export default function BuilderClient({
  initialCandidates,
  initialLeague,
}: BuilderClientProps) {
  const [league, setLeague] = useState(initialLeague);
  const [candidates, setCandidates] = useState<Candidate[]>(initialCandidates);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [submitting, startSubmit] = useTransition();
  const { token, ready, setToken } = useAdminToken();

  const load = useCallback(async (lg: string) => {
    setLoading(true);
    setSelected(new Set());
    try {
      const result = await fetchSuggestionsAction(lg, token);
      if (!result.ok) throw new Error(result.error ?? "Request failed");
      setCandidates(result.data?.candidates ?? []);
    } catch (err) {
      toast.error("Could not load suggestions", {
        description: err instanceof Error ? err.message : undefined,
      });
      setCandidates([]);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    // Without a token every request is "Unauthorized"; the banner below
    // prompts for it, and saving it re-runs this effect.
    if (!ready || !token) return;
    load(league);
  }, [league, load, ready, token]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const selectedLegs = candidates.filter((c) => selected.has(legKey(c)));
  const combined = selectedLegs.reduce((p, c) => p * c.predictedProbability, 1);

  function build() {
    if (selectedLegs.length === 0) return;
    if (!token) {
      toast.error("Could not build parlay", {
        description: "Admin token not set. Paste ADMIN_TOKEN in the banner above.",
      });
      return;
    }
    startSubmit(async () => {
      try {
        const res = await fetch("/api/parlays", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-admin-token": token },
          body: JSON.stringify({ legs: selectedLegs, source: "suggestion" }),
        });
        if (!res.ok) throw new Error(`Request failed (${res.status})`);
        toast.success("Parlay built", {
          description: `${selectedLegs.length} legs saved.`,
        });
        setSelected(new Set());
        load(league);
      } catch (err) {
        toast.error("Could not build parlay", {
          description: err instanceof Error ? err.message : undefined,
        });
      }
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <AdminTokenBanner token={token} ready={ready} onSave={setToken} />
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Parlay builder</h1>
          <p className="text-sm text-muted-foreground">
            Model-suggested +EV legs. Select the ones you want and build a parlay.
          </p>
        </div>
        <Select value={league} onValueChange={(v) => setLeague(v as string)}>
          <SelectTrigger className="w-44">
            <SelectValue>
              {(value) => LEAGUES.find((l) => l.value === value)?.label ?? value}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {LEAGUES.map((l) => (
              <SelectItem key={l.value} value={l.value}>
                {l.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Card>
        {loading ? (
          <CardContent className="flex flex-col gap-2 py-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </CardContent>
        ) : candidates.length === 0 ? (
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            No candidate legs for this league. Sync games and Kalshi markets first.
          </CardContent>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8" />
                <TableHead>Market</TableHead>
                <TableHead>Side</TableHead>
                <TableHead className="text-right">Model</TableHead>
                <TableHead className="text-right">Market</TableHead>
                <TableHead className="text-right">Edge</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {candidates.map((c) => {
                const key = legKey(c);
                return (
                <TableRow
                  key={key}
                  data-state={selected.has(key) ? "selected" : undefined}
                >
                  <TableCell>
                    <input
                      type="checkbox"
                      aria-label={`Select ${c.description}`}
                      className="size-4 accent-primary"
                      checked={selected.has(key)}
                      onChange={() => toggle(key)}
                    />
                  </TableCell>
                  <TableCell className="max-w-xs truncate">{c.description}</TableCell>
                  <TableCell>
                    <Badge variant="outline">{c.side}</Badge>
                  </TableCell>
                  <TableCell className="text-right">{pct(c.predictedProbability)}</TableCell>
                  <TableCell className="text-right">
                    {pct(c.marketImpliedProbability)}
                  </TableCell>
                  <TableCell
                    className={
                      "text-right font-medium " +
                      (c.edge > 0 ? "text-emerald-600" : "text-muted-foreground")
                    }
                  >
                    {c.edge > 0 ? "+" : ""}
                    {(c.edge * 100).toFixed(1)}%
                  </TableCell>
                </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Card>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm text-muted-foreground">
          {selectedLegs.length} legs selected
          {selectedLegs.length > 0 && (
            <>
              {" · "}combined probability{" "}
              <span className="font-medium text-foreground">{pct(combined)}</span>
            </>
          )}
        </div>
        <Button
          disabled={selectedLegs.length === 0 || submitting || !ready || !token}
          onClick={build}
        >
          Build parlay
        </Button>
      </div>
    </div>
  );
}
