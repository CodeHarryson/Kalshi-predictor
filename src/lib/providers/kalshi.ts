import crypto from "crypto";
import fs from "fs";
import path from "path";
import type { League } from "@/generated/prisma/enums";

const BASE_URL = "https://api.elections.kalshi.com/trade-api/v2";
const BASE_PATH = "/trade-api/v2";

// Two ways to feed the provider the key:
//   1. KALSHI_PRIVATE_KEY_PATH=secrets/kalshi.pem   (preferred — Kalshi emails
//      the key as a .txt file, which is just a PEM, and pasting that into
//      a single-line .env strips trailing `=` padding or mangles `\n`.
//      Point this at the .txt file and the provider reads it verbatim.)
//   2. KALSHI_PRIVATE_KEY=-----BEGIN ...\n...        (legacy — single-line
//      value with literal `\n` escapes between the base64 rows. Brittle.)
// KALSHI_KEY_ID is always required (it's just a short string, no newlines).

// Normalized shape the rest of the app works with: prices in integer cents
// (0-100), matching the `yesPrice`/`noPrice` columns on KalshiMarket.
export interface KalshiMarketDto {
  ticker: string;
  title: string;
  // Disambiguates which outcome YES refers to on multi-outcome (3-way)
  // markets, where `title` is identical across all of a game's outcome
  // tickers (e.g. "Argentina vs Switzerland Winner?" for the ARG, SUI, AND
  // Tie tickers). Kalshi sets this per-ticker, e.g. "Reg Time: Argentina".
  yes_sub_title?: string;
  category?: string;
  yes_bid?: number;
  yes_ask?: number;
  no_bid?: number;
  no_ask?: number;
  last_price?: number;
  close_time?: string;
  status?: string;
}

// Kalshi's actual /markets response quotes prices as dollar-denominated
// strings (e.g. "0.3000" = 30 cents) under `*_dollars` keys, not the plain
// numeric-cents fields older docs/snippets suggest. Parsing the wrong field
// names silently leaves every price `undefined`, which is why this needs to
// be an explicit wire type + conversion step rather than trusting `KalshiMarketDto`
// to match the raw response.
interface KalshiRawMarket {
  ticker: string;
  title: string;
  yes_sub_title?: string;
  category?: string;
  yes_bid_dollars?: string;
  yes_ask_dollars?: string;
  no_bid_dollars?: string;
  no_ask_dollars?: string;
  last_price_dollars?: string;
  close_time?: string;
  status?: string;
}

function dollarsToCents(value: string | undefined): number | undefined {
  if (value == null) return undefined;
  const dollars = Number.parseFloat(value);
  if (!Number.isFinite(dollars)) return undefined;
  return Math.round(dollars * 100);
}

function normalizeMarket(raw: KalshiRawMarket): KalshiMarketDto {
  return {
    ticker: raw.ticker,
    title: raw.title,
    yes_sub_title: raw.yes_sub_title,
    category: raw.category,
    yes_bid: dollarsToCents(raw.yes_bid_dollars),
    yes_ask: dollarsToCents(raw.yes_ask_dollars),
    no_bid: dollarsToCents(raw.no_bid_dollars),
    no_ask: dollarsToCents(raw.no_ask_dollars),
    last_price: dollarsToCents(raw.last_price_dollars),
    close_time: raw.close_time,
    status: raw.status,
  };
}

function hasCredentials(): boolean {
  // Only the path form is "fully configured". A KALSHI_PRIVATE_KEY value
  // that doesn't look like PEM (e.g. someone pointed it at a file path
  // instead of using KALSHI_PRIVATE_KEY_PATH) should fail loudly in
  // loadPrivateKey, not be silently treated as configured here.
  return Boolean(
    process.env.KALSHI_KEY_ID &&
      Boolean(process.env.KALSHI_PRIVATE_KEY_PATH) &&
      process.env.KALSHI_PRIVATE_KEY_PATH!.length > 0
  );
}

// Loads the PEM body. Prefers KALSHI_PRIVATE_KEY_PATH (a filesystem path to
// the .txt file Kalshi emailed) and falls back to KALSHI_PRIVATE_KEY (a
// single-line .env value with literal `\n` escapes). The .env path is kept
// for completeness but the file path is the one that works reliably —
// pasting a multi-line PEM into a single-line .env value is the single
// most common source of "OpenSSL: DECODER routines::unsupported" errors,
// because editors strip trailing `=` padding and/or mangle the `\n`
// escapes.
function loadPrivateKey(): string {
  const pathEnv = process.env.KALSHI_PRIVATE_KEY_PATH;
  if (pathEnv && pathEnv.length > 0) {
    const resolved = path.resolve(process.cwd(), pathEnv);
    if (!fs.existsSync(resolved)) {
      throw new Error(
        `KALSHI_PRIVATE_KEY_PATH points at ${resolved} but the file does not exist. ` +
          `Save the Kalshi-issued .txt file there (path is relative to the project root).`
      );
    }
    const pem = fs.readFileSync(resolved, "utf8");
    if (!pem.includes("-----BEGIN")) {
      throw new Error(
        `${resolved} does not look like a PEM file — missing the '-----BEGIN ... PRIVATE KEY-----' header.`
      );
    }
    if (!pem.includes("-----END")) {
      throw new Error(
        `${resolved} does not look like a PEM file — missing the '-----END ... PRIVATE KEY-----' footer.`
      );
    }
    return pem;
  }

  // Legacy .env path. Same shape checks as before; the realistic failure
  // mode here is a base64 body with `mod 4 != 0` (trailing `=` padding
  // was stripped by the editor when the key was pasted), which surfaces
  // as the same `DECODER routines::unsupported` OpenSSL error.
  const raw = process.env.KALSHI_PRIVATE_KEY ?? "";
  if (raw.length === 0) {
    throw new Error(
      "KALSHI_PRIVATE_KEY is empty. Set KALSHI_PRIVATE_KEY_PATH to the path of " +
        "the Kalshi-issued .txt file (preferred), or set KALSHI_PRIVATE_KEY to a " +
        "single-line PEM value with literal '\\n' escapes."
    );
  }
  // Common mistake: KALSHI_PRIVATE_KEY=secrets/kalshi.pem (file path
  // assigned to the wrong variable). Catch it explicitly so the error
  // message tells the user to rename the env var, not to fix the PEM.
  if (!raw.includes("-----") && (raw.includes("/") || raw.includes("\\") || raw.endsWith(".pem") || raw.endsWith(".txt"))) {
    throw new Error(
      `KALSHI_PRIVATE_KEY looks like a file path (${JSON.stringify(raw)}), not a PEM. ` +
        `Rename the env var to KALSHI_PRIVATE_KEY_PATH — it points at a file on disk, not at the key contents.`
    );
  }
  if (raw.includes("\n")) {
    throw new Error(
      "KALSHI_PRIVATE_KEY contains a real newline. .env values must be a single line with literal '\\n' escapes between the base64 rows, " +
        "or use KALSHI_PRIVATE_KEY_PATH to point at the .txt file directly."
    );
  }
  const decoded = raw.replace(/\\n/g, "\n");
  if (!decoded.includes("-----BEGIN")) {
    throw new Error(
      "KALSHI_PRIVATE_KEY is missing the '-----BEGIN ... PRIVATE KEY-----' header. " +
        "Wrap the base64 body with PEM framing."
    );
  }
  if (!decoded.includes("-----END")) {
    throw new Error(
      "KALSHI_PRIVATE_KEY is missing the '-----END ... PRIVATE KEY-----' footer. " +
        "Wrap the base64 body with PEM framing."
    );
  }
  return decoded;
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
    console.warn("[kalshi provider] KALSHI_KEY_ID and KALSHI_PRIVATE_KEY_PATH not set, skipping fetch");
    return null;
  }
  const start = Date.now();
  try {
    const method = "GET";
    // Kalshi signs `timestamp + method + path` where the path is the
    // request path WITHOUT the query string. We still send the query
    // in the URL — only the signed message drops it.
    const pathOnly = path.split("?")[0];
    const fullPath = `${BASE_PATH}${pathOnly}`;
    const timestampMs = String(Date.now());
    let signature: string;
    try {
      signature = signRequest(method, fullPath, timestampMs);
    } catch (err) {
      // loadPrivateKey throws a specific, actionable message; OpenSSL
      // throws a generic ERR_OSSL_UNSUPPORTED for everything else.
      // The kalshiFetch caller already wraps this in a console.warn,
      // so we just pass it through.
      console.warn("[kalshi provider] failed to sign request:", err);
      return null;
    }

    console.info(`[kalshi] GET ${pathOnly} (key=${process.env.KALSHI_KEY_ID?.slice(0, 8)}…, ts=${timestampMs})`);
    const res = await fetch(`${BASE_URL}${path}`, {
      headers: {
        "KALSHI-ACCESS-KEY": process.env.KALSHI_KEY_ID ?? "",
        "KALSHI-ACCESS-SIGNATURE": signature,
        "KALSHI-ACCESS-TIMESTAMP": timestampMs,
      },
    });
    const ms = Date.now() - start;
    if (!res.ok) {
      // Read the body so we surface the actual reason (401 = signature/key,
      // 403 = scope, 429 = rate limit). Truncate to keep logs readable.
      let body = "";
      try {
        body = (await res.text()).slice(0, 300);
      } catch {
        // body read can fail; ignore
      }
      console.warn(`[kalshi] ${pathOnly} -> HTTP ${res.status} in ${ms}ms — ${body}`);
      return null;
    }
    const json = (await res.json()) as T;
    const marketCount =
      json && typeof json === "object" && "markets" in json && Array.isArray((json as { markets: unknown[] }).markets)
        ? (json as { markets: unknown[] }).markets.length
        : "?";
    console.info(`[kalshi] ${pathOnly} -> HTTP ${res.status} in ${ms}ms — ${marketCount} market(s)`);
    return json;
  } catch (err) {
    console.warn(`[kalshi] ${path} failed:`, err);
    return null;
  }
}

// Kalshi doesn't tag markets by league directly, so we look up markets by
// series ticker. `series_ticker` is an exact match on Kalshi's API, not a
// prefix - each league's season-long futures market (e.g. "KXNBA", "Will
// Washington win the 2027 Finals?") lives under a *different* series ticker
// than its per-game moneyline market. Only the per-game series has markets
// `matchMarketToGame` can link to a specific scheduled game (it needs both
// team names in the title), so these list the per-game series tickers only.
// Verified against Kalshi's live series list (GET /series) on 2026-07-10 -
// double check there if a league stops returning markets, since Kalshi
// renames/adds series tickers over time.
const SERIES_PREFIX: Record<League, string[]> = {
  NBA: ["KXNBAGAME"],
  NFL: ["KXNFLGAME"],
  EPL: ["KXEPLGAME"],
  LALIGA: ["KXLALIGAGAME"],
  WORLD_CUP: ["KXWCGAME"],
};

export async function fetchOpenMarkets(league: League): Promise<KalshiMarketDto[]> {
  const prefixes = SERIES_PREFIX[league];
  const all: KalshiMarketDto[] = [];

  for (const prefix of prefixes) {
    const data = await kalshiFetch<{ markets: KalshiRawMarket[] }>(
      `/markets?status=open&series_ticker=${prefix}&limit=200`
    );
    if (data?.markets) all.push(...data.markets.map(normalizeMarket));
  }

  return all;
}

export function isKalshiConfigured(): boolean {
  return hasCredentials();
}
