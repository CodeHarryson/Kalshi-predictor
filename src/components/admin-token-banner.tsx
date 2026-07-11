"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";

interface AdminTokenBannerProps {
  token: string | null;
  ready: boolean;
  onSave: (next: string) => void;
}

/**
 * First-visit prompt for the admin token (matches `process.env.ADMIN_TOKEN`
 * in `.env`). Renders nothing once a token is stored. Pasting the value
 * here writes it to localStorage; the value is then sent as an explicit
 * argument to every admin server action.
 *
 * To rotate the token later, clear the `kalshi-predictor:admin-token`
 * key in DevTools → Application → Local Storage and reload.
 */
export function AdminTokenBanner({ token, ready, onSave }: AdminTokenBannerProps) {
  const [draft, setDraft] = useState("");

  // Don't render during SSR / first paint — would mismatch the server
  // which doesn't know what's in localStorage.
  if (!ready) return null;
  // Once a token is stored, the banner hides itself.
  if (token !== null) return null;

  return (
    <Card className="border-amber-500/40 bg-amber-50/40 dark:bg-amber-950/20">
      <CardContent className="flex flex-col gap-2 py-4">
        <p className="text-sm font-medium">Admin token required</p>
        <p className="text-xs text-muted-foreground">
          Paste the value of <code className="rounded bg-muted px-1">ADMIN_TOKEN</code> from
          your <code className="rounded bg-muted px-1">.env</code>. It is stored in this
          browser&apos;s localStorage and sent with every admin action.
        </p>
        <form
          className="flex flex-col gap-2 sm:flex-row sm:items-center"
          onSubmit={(e) => {
            e.preventDefault();
            if (draft.trim().length > 0) onSave(draft);
          }}
        >
          <Input
            type="password"
            autoComplete="off"
            placeholder="ADMIN_TOKEN value"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="sm:max-w-sm"
          />
          <Button type="submit" size="sm" disabled={draft.trim().length === 0}>
            Save
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
