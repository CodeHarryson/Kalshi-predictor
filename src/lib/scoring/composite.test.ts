import { describe, expect, it } from "vitest";
import { resolveMarketFavoredSide } from "./composite";

const side = (text: string, home: string, away: string, hs: string | null = null, as: string | null = null) =>
  resolveMarketFavoredSide(text, home, hs, away, as);

describe("resolveMarketFavoredSide", () => {
  it("resolves Kalshi's abbreviated sub-titles to the right team", () => {
    // "New York J" must be the Jets, not New England ("ne" is inside "new").
    expect(side("New York J", "New England Patriots", "New York Jets", "NE", "NYJ")).toBe("away");
    expect(side("New England", "New England Patriots", "New York Jets", "NE", "NYJ")).toBe("home");
    expect(side("New York", "New York Knicks", "Philadelphia 76ers", "NYK", "PHI")).toBe("home");
    expect(side("Philadelphia", "New York Knicks", "Philadelphia 76ers", "NYK", "PHI")).toBe("away");
  });

  it("expands 'St.' and separates a school from its State namesake", () => {
    expect(side("Washington St.", "Washington State Cougars", "Boise State Broncos")).toBe("home");
    expect(side("Boise St.", "Washington State Cougars", "Boise State Broncos")).toBe("away");
    expect(side("Michigan", "Michigan Wolverines", "Michigan State Spartans")).toBe("home");
    expect(side("Michigan St.", "Michigan Wolverines", "Michigan State Spartans")).toBe("away");
  });

  it("handles ties, prefixed sub-titles and diacritics", () => {
    expect(side("Tie is the result", "Leeds United FC", "Manchester United FC")).toBe("draw");
    expect(side("Reg Time: Tie", "Argentina", "Switzerland")).toBe("draw");
    expect(side("Reg Time: Argentina", "Argentina", "Switzerland")).toBe("home");
    expect(side("Atletico", "Club Atlético de Madrid", "Real Madrid CF")).toBe("home");
  });

  it("still parses the older 'Will X win' title form", () => {
    expect(side("Will Carolina win the Carolina vs Arizona Pro Football game?", "Arizona Cardinals", "Carolina Panthers")).toBe("away");
  });

  it("doesn't match 2-letter abbreviations inside ordinary words", () => {
    // Neither team is named in the text; "ne"/"la" appear only inside other words.
    expect(side("Will the winner be decided in overtime?", "New England Patriots", "Los Angeles Rams", "NE", "LA")).toBeNull();
  });
});
