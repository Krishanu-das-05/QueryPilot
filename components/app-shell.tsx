"use client";

import { Database, FilePlus2, LayoutGrid, Search } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Toaster } from "sonner";
import { CommandMenu } from "@/components/command-menu";
import { ThemeToggle } from "@/components/theme-provider";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/", label: "Datasets", icon: LayoutGrid },
  { href: "/datasets/new", label: "New dataset", icon: FilePlus2 },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  return (
    <div className="flex min-h-screen">
      <aside className="fixed inset-y-0 z-30 flex w-56 flex-col border-r bg-sidebar">
        <div className="flex h-14 items-center gap-2 border-b px-4">
          <Database className="h-5 w-5 text-accent" />
          <span className="text-base font-semibold tracking-tight">QueryPilot</span>
        </div>
        <div className="p-2">
          <PaletteHint />
        </div>
        <nav className="flex-1 space-y-0.5 p-2">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-2 rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
                pathname === item.href && "bg-muted text-foreground",
              )}
            >
              <item.icon className="h-4 w-4" />
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="border-t p-2">
          <ThemeToggle />
        </div>
      </aside>
      <main className="ml-56 flex-1">
        <div className="mx-auto max-w-5xl px-6 py-8">{children}</div>
      </main>
      <CommandMenu />
      <Toaster richColors position="top-center" />
    </div>
  );
}

function PaletteHint() {
  return (
    <Button
      variant="outline"
      className="w-full justify-start gap-2 text-muted-foreground"
      onClick={() => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }));
      }}
    >
      <Search className="h-4 w-4" />
      Search…
      <kbd className="ml-auto rounded border bg-muted px-1.5 text-[10px]">Ctrl K</kbd>
    </Button>
  );
}
