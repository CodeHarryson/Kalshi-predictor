import crypto from "crypto";
import type { League } from "@/generated/prisma/enums";

const BASE_URL = "https://api.elections.kalshi.com/trade-api/v2";
const BASE_PATH = "/trade-api/v2";

export interface KalshiMarketDto {
  ticker: string;
  title: string;
  category?: string;
  yes_bid?: number;
  yes_ask?: number;
  no_bid?: number;
  no_ask?: number;
  last_price?: number;
  close_time?: string;
  status?: string;
}

function hasCredentials(): boolean {
  return Boolean(process.env.KALSHI_KEY_ID && process.env.KALSHI_PRIVATE_KEY);
}

// Kalshi's PEM key is stored as a single-line env value with literal "\n"
// escapes (the usual workaround for multi-line secrets in .env files).
function loadPrivateKey(): string {
  return (process.env.KALSHI_PRIVATE_KEY ?? "").replace(/\\n/g, "\n");
}

// Kalshi v2 auth: sign `timestampMs + method + path` with the account's RSA
// private key (PSS padding, SHA-256, salt length = digest length) and send
// the result as KALSHI-ACCESS-SIGNATURE alongside the key id and timestamp.
// Ref: https://trading-api.readme.io/reference/api-keys
function signRequest(method: string, path: string, timestampMs: string): string {
  const message = `${timestampMs}${method}${path}`;
  const signature = crypto.sign("sha256", Buffer.from(message), {
    key: loadPrivateKey(),
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
  });
  return signature.toString("base64");
}

async function kalshiFetch<T>(path: string): Promise<T | null> {
  if (!hasCredentials()) {
    console.warn("[kalshi provider] KALSHI_KEY_ID/KALSHI_PRIVATE_KEY not set, skipping fetch");
    return null;
  }
  try {
    const method = "GET";
    const fullPath = `${BASE_PATH}${path}`;
    const timestampMs = String(Date.now());
    let signature: string;
    try {
      signature = signRequest(method, fullPath, timestampMs);
    } catch (err) {
      console.warn("[kalshi provider] failed to sign request (check KALSHI_PRIVATE_KEY format):", err);
      return null;
    }

    const res = await fetch(`${BASE_URL}${path}`, {
      headers: {
        "KALSHI-ACCESS-KEY": process.env.KALSHI_KEY_ID ?? "",
        "KALSHI-ACCESS-SIGNATURE": signature,
        "KALSHI-ACCESS-TIMESTAMP": timestampMs,
      },
    });
    if (!res.ok) {
      console.warn(`[kalshi provider] ${path} -> HTTP ${res.status}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    console.warn(`[kalshi provider] ${path} failed:`, err);
    return null;
  }
}

// Kalshi doesn't tag markets by league directly - series tickers for sports
// are prefixed by sport/competition (e.g. "KXNBAGAME", "KXNFLGAME",
// "KXEPLGAME"). This maps our leagues to the series ticker prefixes we look
// for when listing markets. These prefixes should be double-checked against
// Kalshi's live series list (GET /series) once real API access is available,
// since Kalshi renames/adds series tickers over time.
const SERIES_PREFIX: Record<League, string[]> = {
  NBA: ["KXNBA"],
  NFL: ["KXNFL"],
  EPL: ["KXEPL", "KXEPLGAME"],
  LALIGA: ["KXLALIGA"],
  WORLD_CUP: ["KXWORLDCUP", "KXFIFAWC"],
};

export async function fetchOpenMarkets(league: League): Promise<KalshiMarketDto[]> {
  const prefixes = SERIES_PREFIX[league];
  const all: KalshiMarketDto[] = [];

  for (const prefix of prefixes) {
    const data = await kalshiFetch<{ markets: KalshiMarketDto[] }>(
      `/markets?status=open&series_ticker=${prefix}&limit=200`
    );
    if (data?.markets) all.push(...data.markets);
  }

  return all;
}

export function isKalshiConfigured(): boolean {
  return hasCredentials();
}
