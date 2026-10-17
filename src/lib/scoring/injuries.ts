import type { League } from "@/generated/prisma/enums";

/**
 * Turns injury-report rows into an Elo penalty for a team.
 *
 * Each injured player contributes `availabilityLoss * impactElo`:
 *  - availabilityLoss: chance the player misses the game, from the report
 *    status (Out = 1, Questionable = 0.35, ...).
 *  - impactElo: rating points the team loses if that player is out, derived
 *    from how much the player matters (minutes/scoring in the NBA, position
 *    and starter status in football).
 *
 * The constants are explainable v1 estimates, not fitted values. Spread
 * points are converted to Elo with the league's own scale (the home-field
 * bonus in elo.ts is ~3 pts in the NBA and ~2.2 in the NFL).
 */

const ELO_PER_POINT: Partial<Record<League, number>> = {
  NBA: 33,
  NFL: 25,
  CFB: 25,
};

/** Soft ceiling on a team's total penalty so a long injury list can't swamp Elo. */
export const MAX_TEAM_INJURY_ELO = 250;

export function availabilityLoss(status: string): number {
  const s = status.trim().toLowerCase();
  if (s === "out" || s.includes("injured reserve") || s.includes("suspension") || s.includes("out for")) return 1;
  if (s === "doubtful") return 0.85;
  if (s === "questionable") return 0.35;
  if (s === "day-to-day") return 0.3;
  if (s === "probable") return 0.1;
  return 0; // "Active", unknown labels
}

export interface NbaPlayerStats {
  minutesPerGame: number;
  pointsPerGame: number;
}

/** NBA: a rotation player's minutes plus scoring above a role-player baseline. */
export function nbaImpactElo(stats: NbaPlayerStats | null): number {
  if (!stats) return 0;
  const points =
    0.1 * Math.max(0, stats.minutesPerGame - 12) + 0.15 * Math.max(0, stats.pointsPerGame - 15);
  return points * (ELO_PER_POINT.NBA ?? 33);
}

// Spread-point value of losing a *starter* at each football position.
const FOOTBALL_POSITION_POINTS: Record<string, number> = {
  QB: 5.5,
  RB: 0.8,
  FB: 0.2,
  WR: 0.9,
  TE: 0.6,
  C: 0.7,
  G: 0.7,
  OG: 0.7,
  T: 0.7,
  OT: 0.7,
  OL: 0.7,
  DE: 0.8,
  DT: 0.8,
  NT: 0.7,
  DL: 0.8,
  EDGE: 0.8,
  LB: 0.5,
  ILB: 0.5,
  OLB: 0.6,
  MLB: 0.5,
  CB: 0.7,
  S: 0.5,
  FS: 0.5,
  SS: 0.5,
  DB: 0.5,
  K: 0.3,
  PK: 0.3,
  P: 0.2,
};

// Depth is unknown (CFB has no depth chart data) -> treat as half a starter.
const UNKNOWN_DEPTH_FACTOR = 0.5;
const BACKUP_FACTOR = 0.1;

/**
 * Football: position value, scaled by whether the player starts. A backup
 * QB on the injury report barely matters; the starting QB is worth ~5 pts.
 * `isStarter` null means depth information isn't available.
 */
export function footballImpactElo(
  league: League,
  position: string | null,
  isStarter: boolean | null
): number {
  const base = FOOTBALL_POSITION_POINTS[(position ?? "").toUpperCase()] ?? 0;
  const depth = isStarter === null ? UNKNOWN_DEPTH_FACTOR : isStarter ? 1 : BACKUP_FACTOR;
  return base * depth * (ELO_PER_POINT[league] ?? 25);
}

export interface InjuryLike {
  availabilityLoss: number;
  impactElo: number;
}

/**
 * Sums expected Elo loss, with diminishing returns toward MAX_TEAM_INJURY_ELO
 * (a team missing ten role players isn't ten times a team missing one).
 */
export function teamInjuryPenaltyElo(rows: InjuryLike[]): number {
  const raw = rows.reduce((sum, r) => sum + r.availabilityLoss * r.impactElo, 0);
  if (raw <= 0) return 0;
  return MAX_TEAM_INJURY_ELO * (1 - Math.exp(-raw / MAX_TEAM_INJURY_ELO));
}
