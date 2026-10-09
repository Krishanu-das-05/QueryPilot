"use client";

import { Command } from "cmdk";
import { Database, FilePlus2, LayoutGrid, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Dialog } from "@/components/ui/dialog";
import { DialogContent, DialogTitle } from "@/components/ui/dialog";

interface DatasetItem {
  id: string;
  name: string;
  status: string;
}

export function CommandMenu() {
  const [open, setOpen] = useState(false);
  const [datasets, setDatasets] = useState<DatasetItem[]>([]);
  const router = useRouter();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!open) return;
    fetch("/api/datasets")
      .then((r) => (r.ok ? r.json() : []))
      .then((rows: DatasetItem[]) => setDatasets(rows))
      .catch(() => setDatasets([]));
  }, [open]);

  const go = (path: string) => {
    setOpen(false);
    router.push(path);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="top-[20%] translate-y-0 p-0">
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <Command className="flex flex-col">
          <div className="flex items-center gap-2 border-b px-4">
            <Search className="h-4 w-4 text-muted-foreground" />
            <Command.Input
              autoFocus
              placeholder="Search datasets, jump to actions…"
              className="h-11 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>
          <Command.List className="max-h-72 overflow-y-auto p-2">
            <Command.Empty className="py-6 text-center text-sm text-muted-foreground">
              Nothing found.
            </Command.Empty>
            <Command.Group
              heading="Actions"
              className="text-xs text-muted-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1"
            >
              <Item icon={<FilePlus2 />} onSelect={() => go("/datasets/new")}>
                New dataset
              </Item>
              <Item icon={<LayoutGrid />} onSelect={() => go("/")}>
                All datasets
              </Item>
            </Command.Group>
            {datasets.length > 0 && (
              <Command.Group
                heading="Datasets"
                className="text-xs text-muted-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1"
              >
                {datasets.map((d) => (
                  <Item
                    key={d.id}
                    icon={<Database />}
                    keywords={[d.name, d.status]}
                    onSelect={() => go(`/datasets/${d.id}`)}
                  >
                    {d.name}
                    <span className="ml-auto text-xs text-muted-foreground">{d.status}</span>
                  </Item>
                ))}
              </Command.Group>
            )}
          </Command.List>
        </Command>
      </DialogContent>
    </Dialog>
  );
}

function Item({
  icon,
  children,
  keywords,
  onSelect,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
  keywords?: string[];
  onSelect: () => void;
}) {
  return (
    <Command.Item
      keywords={[typeof children === "string" ? children : "", ...(keywords ?? [])]}
      onSelect={onSelect}
      className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-sm data-[selected=true]:bg-muted [&_svg]:h-4 [&_svg]:w-4 [&_svg]:text-muted-foreground"
    >
      {icon}
      {children}
    </Command.Item>
  );
}
