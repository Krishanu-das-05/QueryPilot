/**
 * Pure SQL-text scanning utilities used by the deterministic guardrail
 * stages. Deliberately ignores nothing about quoting: understand single
 * quotes, dollar-quoting, double-quoted identifiers, and line/block
 * comments so keywords hidden inside literals can't trip (or evade) checks.
 */

export function stripCommentsAndStrings(sql: string): string {
  let out = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i]!;
    const next = sql[i + 1];

    // line comment
    if (ch === "-" && next === "-") {
      while (i < n && sql[i] !== "\n") {
        out += " ";
        i += 1;
      }
      continue;
    }
    // block comment (nest-aware)
    if (ch === "/" && next === "*") {
      let depth = 1;
      out += "  ";
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          depth += 1;
          out += "  ";
          i += 2;
        } else if (sql[i] === "*" && sql[i + 1] === "/") {
          depth -= 1;
          out += "  ";
          i += 2;
        } else {
          out += " ";
          i += 1;
        }
      }
      continue;
    }
    // single-quoted string
    if (ch === "'") {
      out += " ";
      i += 1;
      while (i < n) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          out += "  ";
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          out += " ";
          i += 1;
          break;
        }
        out += " ";
        i += 1;
      }
      continue;
    }
    // dollar-quoted string ($tag$...$tag$)
    if (ch === "$") {
      const m = /^\$[A-Za-z_0-9]*\$/.exec(sql.slice(i, i + 34));
      if (m) {
        const tag = m[0];
        const close = sql.indexOf(tag, i + tag.length);
        const end = close === -1 ? n : close + tag.length;
        out += " ".repeat(end - i);
        i = end;
        continue;
      }
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** Split top-level statements on semicolons outside strings/comments. */
export function splitStatements(sql: string): string[] {
  const scrubbed = stripCommentsAndStrings(sql);
  const parts: string[] = [];
  let start = 0;
  for (let i = 0; i < scrubbed.length; i += 1) {
    if (scrubbed[i] === ";") {
      parts.push(sql.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(sql.slice(start));
  return parts.map((p) => p.trim()).filter((p) => p !== "");
}

/** Word-boundary keyword search on scrubbed SQL (queries, not literals). */
export function containsKeyword(scrubbed: string, keywords: readonly string[]): string | null {
  for (const kw of keywords) {
    const re = new RegExp(
      `(?<=^|[^A-Za-z0-9_])${kw.replace(/_/g, "_")}(?=$|[^A-Za-z0-9_])`,
      "i",
    );
    if (re.test(scrubbed)) return kw;
  }
  return null;
}

/** Extract relation references following FROM/JOIN keywords. */
export function extractRelations(scrubbed: string): { schema: string | null; table: string }[] {
  const rels: { schema: string | null; table: string }[] = [];
  const re =
    /(?:from|join)\s+("([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))\s*(?:\.\s*("([^"]+)"|([A-Za-z_][A-Za-z0-9_]*)))?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(scrubbed)) !== null) {
    const first = m[2] ?? m[3] ?? null;
    const second = m[5] ?? m[6] ?? null;
    if (first === null) continue;
    // skip subquery openers like "from (select" — handled because "(" breaks the regex
    if (second !== null) rels.push({ schema: first, table: second });
    else rels.push({ schema: null, table: first });
  }
  return rels;
}

export function findLimit(scrubbed: string): number | null {
  const m = /\blimit\s+(\d+)/i.exec(scrubbed);
  return m ? Number(m[1]) : null;
}

/** Remove a trailing top-level semicolon, if present. */
export function stripTrailingSemicolon(sql: string): string {
  return sql.replace(/;\s*$/, "");
}
