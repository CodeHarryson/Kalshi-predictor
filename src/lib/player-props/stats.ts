import type { League, PropKind } from "@/generated/prisma/enums";

/** Player-prop series Kalshi lists per league, and the stat each one grades. */
export const PLAYER_PROP_SERIES: Partial<Record<League, Record<string, PropKind>>> = {
  NBA: {
    KXNBAPTS: "PLAYER_POINTS",
    KXNBAREB: "PLAYER_REBOUNDS",
    KXNBAAST: "PLAYER_ASSISTS",
    KXNBA3PT: "PLAYER_THREES",
  },
  NFL: {
    KXNFLPASSYDS: "PLAYER_PASS_YDS",
    KXNFLPASSCOMP: "PLAYER_PASS_COMP",
    KXNFLRSHYDS: "PLAYER_RUSH_YDS",
    KXNFLRECYDS: "PLAYER_REC_YDS",
    KXNFLTD: "PLAYER_TDS",
  },
};

export const PLAYER_PROP_LEAGUES = Object.keys(PLAYER_PROP_SERIES) as League[];

export const PLAYER_PROP_KINDS: PropKind[] = Object.values(PLAYER_PROP_SERIES).flatMap((m) => Object.values(m!));

export function isPlayerPropKind(kind: string | null | undefined): kind is PropKind {
  return !!kind && (PLAYER_PROP_KINDS as string[]).includes(kind);
}

/** Wording for a leg: "35+ points" / "under 35 points". */
const STAT_LABEL: Record<string, string> = {
  PLAYER_POINTS: "points",
  PLAYER_REBOUNDS: "rebounds",
  PLAYER_ASSISTS: "assists",
  PLAYER_THREES: "threes",
  PLAYER_PASS_YDS: "passing yards",
  PLAYER_PASS_COMP: "completions",
  PLAYER_RUSH_YDS: "rushing yards",
  PLAYER_REC_YDS: "receiving yards",
  PLAYER_TDS: "touchdowns",
};

export function propLegLabel(kind: PropKind, threshold: number, side: "YES" | "NO"): string {
  const stat = STAT_LABEL[kind] ?? "";
  return side === "YES" ? `${threshold}+ ${stat}` : `under ${threshold} ${stat}`;
}

export type StatLine = Record<string, number | string>;

function num(v: number | string | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Reads the stat a prop kind grades from one game's stat line; null when the line lacks it. */
export function statFor(kind: PropKind, line: StatLine): number | null {
  switch (kind) {
    case "PLAYER_POINTS": return num(line.points);
    case "PLAYER_REBOUNDS": return num(line.totalRebounds);
    case "PLAYER_ASSISTS": return num(line.assists);
    case "PLAYER_THREES": return num(line.threes);
    case "PLAYER_PASS_YDS": return num(line.passingYards);
    case "PLAYER_PASS_COMP": return num(line.completions);
    case "PLAYER_RUSH_YDS": return num(line.rushingYards);
    case "PLAYER_REC_YDS": return num(line.receivingYards);
    case "PLAYER_TDS": {
      const r = num(line.rushingTouchdowns);
      const c = num(line.receivingTouchdowns);
      return r === null && c === null ? null : (r ?? 0) + (c ?? 0);
    }
    default: return null;
  }
}

/** Parses a Kalshi prop sub-title such as "Victor Wembanyama: 35+" into name and threshold. */
export function parsePlayerPropTitle(subTitle: string | null | undefined): { name: string; threshold: number } | null {
  const m = /^(.+?):\s*(\d+(?:\.\d+)?)\+/.exec(subTitle ?? "");
  if (!m) return null;
  const threshold = Number.parseFloat(m[2]);
  return Number.isFinite(threshold) ? { name: m[1].trim(), threshold } : null;
}

/** Lowercase, accent-free, no punctuation or generational suffix, for matching names across feeds. */
export function normalizeName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[.'’,-]/g, " ")
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
