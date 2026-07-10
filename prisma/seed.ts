import { PrismaClient } from "../src/generated/prisma/client";
import type { League } from "../src/generated/prisma/enums";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";

const adapter = new PrismaBetterSqlite3({
  url: process.env.DATABASE_URL ?? "file:./dev.db",
});
const db = new PrismaClient({ adapter });

const TEAMS: Record<League, { name: string; shortName: string; externalId: string }[]> = {
  NBA: [
    { name: "Boston Celtics", shortName: "BOS", externalId: "seed-nba-bos" },
    { name: "Los Angeles Lakers", shortName: "LAL", externalId: "seed-nba-lal" },
    { name: "Denver Nuggets", shortName: "DEN", externalId: "seed-nba-den" },
  ],
  NFL: [
    { name: "Kansas City Chiefs", shortName: "KC", externalId: "seed-nfl-kc" },
    { name: "San Francisco 49ers", shortName: "SF", externalId: "seed-nfl-sf" },
    { name: "Buffalo Bills", shortName: "BUF", externalId: "seed-nfl-buf" },
  ],
  EPL: [
    { name: "Arsenal", shortName: "ARS", externalId: "seed-epl-ars" },
    { name: "Manchester City", shortName: "MCI", externalId: "seed-epl-mci" },
    { name: "Liverpool", shortName: "LIV", externalId: "seed-epl-liv" },
  ],
  LALIGA: [
    { name: "Real Madrid", shortName: "RMA", externalId: "seed-laliga-rma" },
    { name: "FC Barcelona", shortName: "BAR", externalId: "seed-laliga-bar" },
    { name: "Atletico Madrid", shortName: "ATM", externalId: "seed-laliga-atm" },
  ],
  WORLD_CUP: [
    { name: "Brazil", shortName: "BRA", externalId: "seed-wc-bra" },
    { name: "France", shortName: "FRA", externalId: "seed-wc-fra" },
    { name: "Argentina", shortName: "ARG", externalId: "seed-wc-arg" },
  ],
};

async function seedLeague(league: League) {
  const teams = TEAMS[league];
  const teamIds: string[] = [];

  for (const t of teams) {
    const team = await db.team.upsert({
      where: { league_externalId: { league, externalId: t.externalId } },
      create: { league, name: t.name, shortName: t.shortName, externalId: t.externalId },
      update: { name: t.name, shortName: t.shortName },
    });
    teamIds.push(team.id);
  }

  const now = Date.now();
  const games = [
    { externalId: `seed-${league}-game-1`, homeTeamId: teamIds[0], awayTeamId: teamIds[1], days: 2 },
    { externalId: `seed-${league}-game-2`, homeTeamId: teamIds[1], awayTeamId: teamIds[2], days: 5 },
  ];

  for (const g of games) {
    await db.game.upsert({
      where: { league_externalId: { league, externalId: g.externalId } },
      create: {
        league,
        externalId: g.externalId,
        startTime: new Date(now + g.days * 86_400_000),
        status: "SCHEDULED",
        homeTeamId: g.homeTeamId,
        awayTeamId: g.awayTeamId,
      },
      update: {
        startTime: new Date(now + g.days * 86_400_000),
        status: "SCHEDULED",
      },
    });
  }
}

async function main() {
  const leagues: League[] = ["NBA", "NFL", "EPL", "LALIGA", "WORLD_CUP"];
  for (const league of leagues) {
    await seedLeague(league);
  }
  console.log("Seed complete.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
