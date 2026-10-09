import { ArrowRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export interface Rel {
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
  overlap: number;
  method: string;
}

/** Simple, readable relationship summary: one card per FK edge, ordered list. */
export default function RelationshipGraph({ relationships }: { relationships: Rel[] }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {relationships.map((r, i) => (
        <Card key={i}>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 font-mono text-sm">
              <span className="text-muted-foreground">{r.fromTable}</span>
              <ArrowRight className="h-4 w-4 text-accent" />
              <span>{r.toTable}</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="flex items-center gap-2 font-mono text-xs text-muted-foreground">
            <span>
              {r.fromTable}.{r.fromColumn}
            </span>
            <span className="text-accent">→</span>
            <span>
              {r.toTable}.{r.toColumn}
            </span>
            <Badge variant="secondary" className="ml-auto">
              {Math.round(r.overlap * 100)}% overlap
            </Badge>
            <Badge variant="outline">{r.method}</Badge>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
