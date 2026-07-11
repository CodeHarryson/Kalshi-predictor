-- Adds yesSubTitle: the field Kalshi uses to disambiguate which outcome a
-- market's YES side refers to on multi-outcome (3-way) markets, where the
-- shared `title` alone is ambiguous (e.g. "Argentina vs Switzerland Winner?"
-- is the title for all three of the ARG/SUI/TIE outcome tickers).
ALTER TABLE "KalshiMarket" ADD COLUMN "yesSubTitle" TEXT;
