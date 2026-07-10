"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const LINKS = [
  { href: "/", label: "Dashboard" },
  { href: "/builder", label: "Builder" },
  { href: "/history", label: "History" },
  { href: "/model", label: "Model" },
];

export function NavBar() {
  const pathname = usePathname();

  return (
    <header className="border-b bg-background sticky top-0 z-10">
      <div className="mx-auto flex max-w-6xl items-center gap-6 px-4 py-3">
        <span className="font-semibold tracking-tight">Kalshi Parlay Predictor</span>
        <nav className="flex gap-1">
          {LINKS.map((link) => {
            const active =
              link.href === "/" ? pathname === "/" : pathname.startsWith(link.href);
            return (
              <Link
                key={link.href}
                href={link.href}
                className={cn(
                  "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                  active
                    ? "bg-secondary text-secondary-foreground"
                    : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground"
                )}
              >
                {link.label}
              </Link>
            );
          })}
        </nav>
      </div>
    </header>
  );
}
