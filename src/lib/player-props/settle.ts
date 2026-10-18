import { db } from "@/lib/db";
import type { League, PropKind } from "@/generated/prisma/enums";
import { fetchGameLog } from "./espn";
import { statFor } from "./stats";

const SAME_GAME_MS = 12 * 60 * 60 * 1000;
/** After this long with no log entry, the player did not play: Kalshi settles those at a fair price. */
const NO_SHOW_GRACE_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * Grades a player-stat leg from ESPN's game log for the finished game. Returns
 * null while the stat line isn't available yet (the leg stays PENDING), and
 * PUSH when the player never appeared.
 */
export async function settlePlayerPropLeg(args: {
  side: "YES" | "NO";
  league: League;
  propKind: PropKind;
  threshold: number;
  playerId: string;
  gameStart: Date;
}): Promise<"WON" | "LOST" | "PUSH" | null> {
  const player = await db.player.findUnique({ where: { id: args.playerId }, select: { externalIds: true } });
  let espnId: string | undefined;
  try { espnId = player ? JSON.parse(player.externalIds).espn : undefined; } catch { espnId = undefined; }
  if (!espnId) return null;

  const rows = await fetchGameLog(args.league, String(espnId));
  const row = rows.find((r) => Math.abs(r.gameDate.getTime() - args.gameStart.getTime()) < SAME_GAME_MS);
  if (!row) return Date.now() - args.gameStart.getTime() > NO_SHOW_GRACE_MS ? "PUSH" : null;

  const value = statFor(args.propKind, row.stats);
  if (value === null) return null;
  const hit = value >= args.threshold;
  return (args.side === "YES") === hit ? "WON" : "LOST";
}
