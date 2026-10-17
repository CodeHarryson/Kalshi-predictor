export interface ParlayLegCandidate {
  // Null for tournament-scoped legs (e.g. PLAYER_GOALS) with no single game.
  gameId: string | null;
  probability: number;
  marketImpliedProbability?: number;
}

/** Naive-independence combination: product of leg probabilities. */
export function combineParlayProbability(legs: ParlayLegCandidate[]): number {
  return legs.reduce((p, leg) => p * leg.probability, 1);
}

/** Kalshi YES prices are quoted in cents (0-100); implied prob is price/100. */
export function impliedProbabilityFromPriceCents(priceCents: number): number {
  return priceCents / 100;
}

export function computeEdge(modelProbability: number, marketImpliedProbability: number): number {
  return modelProbability - marketImpliedProbability;
}

// Quarter-Kelly, capped at 5% of bankroll. Full Kelly is punishing when the
// input probability is wrong, and `combineParlayProbability`'s naive
// independence assumption (see builder.ts) makes multi-leg combinedProbability
// increasingly overconfident as legs are added - so this deliberately stakes
// well under what full Kelly would suggest.
const FRACTIONAL_KELLY = 0.25;
const MAX_BANKROLL_FRACTION = 0.05;

export function recommendStakeCents(
  bankrollCents: number,
  modelProbability: number,
  marketImpliedProbability: number
): number {
  if (bankrollCents <= 0) return 0;
  if (marketImpliedProbability <= 0 || marketImpliedProbability >= 1) return 0;

  const b = (1 - marketImpliedProbability) / marketImpliedProbability; // net odds
  const kelly = (modelProbability * b - (1 - modelProbability)) / b;
  if (kelly <= 0) return 0; // no recommended stake when the model doesn't favor this combo

  const fraction = Math.min(kelly * FRACTIONAL_KELLY, MAX_BANKROLL_FRACTION);
  return Math.round(fraction * bankrollCents);
}
