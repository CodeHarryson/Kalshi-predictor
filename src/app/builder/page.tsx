import { headers } from "next/headers";
import { requireAdmin } from "@/lib/admin-auth";
import BuilderClient from "./BuilderClient";

export const dynamic = "force-dynamic"; // admin token in headers — never cache

async function fetchCandidates(league: string, token: string): Promise<unknown[]> {
  // Call the route handler in-process with a forged header.
  // This exercises the same requireAdmin code path as a curl call would.
  const { GET } = await import("@/app/api/parlays/suggestions/route");
  const req = new Request(
    `http://internal/api/parlays/suggestions?league=${league}`,
    { headers: { "x-admin-token": token } }
  );
  const res = await GET(req);
  if (!res.ok) {
    throw new Error(`suggestions fetch failed: ${res.status}`);
  }
  const data = (await res.json()) as { candidates?: unknown[] };
  return data.candidates ?? [];
}

export default async function BuilderPage() {
  const token = (await headers()).get("x-admin-token");
  // Defense in depth: also gate the page render itself. If a bad token reaches
  // the RSC, the route call below would already have returned 401, but we want
  // to short-circuit the page too.
  if (!token) {
    return <BuilderClient initialCandidates={[]} initialLeague="NFL" />;
  }
  const gate = requireAdmin(
    new Request("http://internal/builder", {
      headers: { "x-admin-token": token },
    })
  );
  if (gate) {
    return <BuilderClient initialCandidates={[]} initialLeague="NFL" />;
  }

  let candidates: unknown[] = [];
  try {
    candidates = await fetchCandidates("NFL", token);
  } catch {
    candidates = [];
  }
  return (
    <BuilderClient
      initialCandidates={candidates as Parameters<typeof BuilderClient>[0]["initialCandidates"]}
      initialLeague="NFL"
    />
  );
}
