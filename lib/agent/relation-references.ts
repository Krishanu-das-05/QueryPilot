interface Token {
  kind: "word" | "quoted" | "literal" | "symbol";
  value: string;
}

export interface TableReference {
  schema: string | null;
  table: string;
}

export class RelationParseError extends Error {}

const CLAUSES = new Set([
  "where", "group", "having", "window", "order", "limit", "offset",
  "fetch", "union", "intersect", "except", "for", "returning",
]);
const NON_ALIASES = new Set([
  ...CLAUSES, "from", "join", "left", "right", "full", "inner", "outer",
  "cross", "natural", "on", "using", "as", "lateral", "only", "tablesample",
]);

function invalid(): never {
  throw new RelationParseError("unsupported-relation-syntax");
}

function tokenize(sql: string): Token[] {
  if (sql.length > 20000) invalid();
  const tokens: Token[] = [];
  let i = 0;
  while (i < sql.length) {
    const char = sql[i]!;
    if (/\s/.test(char)) {
      i += 1;
    } else if (sql.startsWith("--", i)) {
      while (i < sql.length && !/[\r\n]/.test(sql[i]!)) i += 1;
    } else if (sql.startsWith("/*", i)) {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql.startsWith("/*", i)) {
          depth += 1;
          i += 2;
        } else if (sql.startsWith("*/", i)) {
          depth -= 1;
          i += 2;
        } else {
          i += 1;
        }
      }
      if (depth) invalid();
    } else if (char === "'" || (/[eE]/.test(char) && sql[i + 1] === "'")) {
      const escaped = char !== "'";
      i += escaped ? 2 : 1;
      let closed = false;
      while (i < sql.length) {
        if (escaped && sql[i] === "\\") {
          i += 2;
        } else if (sql[i] === "'") {
          i += 1;
          if (sql[i] === "'") i += 1;
          else {
            closed = true;
            break;
          }
        } else {
          i += 1;
        }
      }
      if (!closed) invalid();
      tokens.push({ kind: "literal", value: "" });
    } else if (char === '"') {
      let value = "";
      let closed = false;
      i += 1;
      while (i < sql.length) {
        if (sql[i] === '"') {
          i += 1;
          if (sql[i] === '"') {
            value += '"';
            i += 1;
          } else {
            closed = true;
            break;
          }
        } else {
          value += sql[i++]!;
        }
      }
      if (!closed || !value) invalid();
      tokens.push({ kind: "quoted", value });
    } else if (char === "$") {
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (tag) {
        const close = sql.indexOf(tag[0], i + tag[0].length);
        if (close < 0) invalid();
        i = close + tag[0].length;
        tokens.push({ kind: "literal", value: "" });
      } else {
        const parameter = /^\$[0-9]+/.exec(sql.slice(i));
        if (!parameter) invalid();
        i += parameter[0].length;
        tokens.push({ kind: "literal", value: "" });
      }
    } else if (/[A-Za-z_]/.test(char)) {
      const start = i++;
      while (i < sql.length && /[A-Za-z0-9_$]/.test(sql[i]!)) i += 1;
      const value = sql.slice(start, i).toLowerCase();
      if (value === "u" && sql[i] === "&" && /['"]/.test(sql[i + 1] ?? "")) invalid();
      tokens.push({ kind: "word", value });
    } else {
      tokens.push({ kind: "symbol", value: char });
      i += 1;
    }
  }
  return tokens;
}

export function extractTableReferences(sql: string): TableReference[] {
  const tokens = tokenize(sql);
  if (tokens.at(-1)?.value === ";" && tokens.at(-1)?.kind === "symbol") tokens.pop();
  if (tokens.some((token) => token.kind === "symbol" && token.value === ";")) invalid();
  const pairs = new Map<number, number>();
  const stack: number[] = [];
  const refs: TableReference[] = [];
  const word = (i: number, ...values: string[]) =>
    tokens[i]?.kind === "word" && values.includes(tokens[i]!.value);
  const symbol = (i: number, value: string) =>
    tokens[i]?.kind === "symbol" && tokens[i]?.value === value;
  const identifier = (i: number) =>
    tokens[i]?.kind === "word" || tokens[i]?.kind === "quoted";

  tokens.forEach((token, index) => {
    if (token.kind !== "symbol") return;
    if (token.value === "(") {
      stack.push(index);
      if (stack.length > 64) invalid();
    } else if (token.value === ")") {
      const open = stack.pop();
      if (open === undefined) invalid();
      pairs.set(open, index);
    }
  });
  if (stack.length) invalid();

  function closeAt(start: number, end: number): number {
    const close = pairs.get(start);
    if (close === undefined || close >= end) invalid();
    return close;
  }

  function queryStart(start: number, end: number): boolean {
    while (symbol(start, "(") && pairs.get(start) === end - 1) {
      start += 1;
      end -= 1;
    }
    return word(start, "select", "with", "values");
  }

  function expression(start: number, end: number, visible: ReadonlySet<string>): void {
    let i = start;
    while (i < end) {
      if (!symbol(i, "(")) {
        i += 1;
        continue;
      }
      const close = closeAt(i, end);
      if (queryStart(i + 1, close)) scope(i + 1, close, visible);
      else expression(i + 1, close, visible);
      i = close + 1;
    }
  }

  function alias(start: number, end: number): number {
    let i = start;
    if (word(i, "as")) {
      i += 1;
      if (i >= end || !identifier(i)) invalid();
      i += 1;
    } else if (i < end && identifier(i) &&
        (tokens[i]!.kind === "quoted" || !NON_ALIASES.has(tokens[i]!.value))) {
      i += 1;
    }
    if (symbol(i, "(")) {
      const close = closeAt(i, end);
      for (let column = i + 1; column < close; column += 1) {
        if (!identifier(column) && !symbol(column, ",")) invalid();
      }
      i = close + 1;
    }
    return i;
  }

  function relation(start: number, end: number, visible: ReadonlySet<string>): number {
    let i = start;
    while (word(i, "only", "lateral")) i += 1;
    if (symbol(i, "(")) {
      const close = closeAt(i, end);
      if (!queryStart(i + 1, close)) invalid();
      scope(i + 1, close, visible);
      return alias(close + 1, end);
    }
    if (i >= end || !identifier(i)) invalid();
    const first = tokens[i++]!.value;
    let table = first;
    let schema: string | null = null;
    if (symbol(i, ".")) {
      i += 1;
      if (i >= end || !identifier(i)) invalid();
      schema = first;
      table = tokens[i++]!.value;
    }
    if (symbol(i, ".") || symbol(i, "(")) invalid();
    if (schema !== null || !visible.has(table)) refs.push({ schema, table });
    return alias(i, end);
  }

  function scope(start: number, end: number, inherited: ReadonlySet<string>): void {
    while (symbol(start, "(") && pairs.get(start) === end - 1) {
      start += 1;
      end -= 1;
    }
    const visible = new Set(inherited);
    let i = start;
    if (word(i, "with")) {
      i += 1;
      const recursive = word(i, "recursive");
      if (recursive) i += 1;
      while (i < end) {
        if (!identifier(i)) invalid();
        const name = tokens[i++]!.value;
        if (symbol(i, "(")) i = closeAt(i, end) + 1;
        if (!word(i, "as")) invalid();
        i += 1;
        if (word(i, "not")) {
          i += 1;
          if (!word(i, "materialized")) invalid();
        }
        if (word(i, "materialized")) i += 1;
        if (!symbol(i, "(")) invalid();
        const close = closeAt(i, end);
        const bodyVisible = new Set(visible);
        if (recursive) bodyVisible.add(name);
        if (!queryStart(i + 1, close)) invalid();
        scope(i + 1, close, bodyVisible);
        visible.add(name);
        i = close + 1;
        if (!symbol(i, ",")) break;
        i += 1;
      }
    }
    if (!word(i, "select", "values")) invalid();
    let inFrom = false;
    while (i < end) {
      if (symbol(i, "(")) {
        const close = closeAt(i, end);
        if (queryStart(i + 1, close)) scope(i + 1, close, visible);
        else expression(i + 1, close, visible);
        i = close + 1;
      } else if (word(i, "from") && !word(i - 1, "distinct")) {
        inFrom = true;
        i = relation(i + 1, end, visible);
      } else if (word(i, "join") || (inFrom && symbol(i, ","))) {
        inFrom = true;
        i = relation(i + 1, end, visible);
      } else {
        if (tokens[i]?.kind === "word" && CLAUSES.has(tokens[i]!.value)) inFrom = false;
        if (word(i, "tablesample")) invalid();
        i += 1;
      }
    }
  }

  scope(0, tokens.length, new Set());
  return refs;
}
