export interface ParlayLegCandidate {
  gameId: string;
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
