import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sanitizeHeaders } from "@/lib/ingest/headers";
import { parseCsv } from "@/lib/ingest/parse";
import { profileTable } from "@/lib/ingest/profile";

const DIR = join(__dirname, "..", "evals", "messy-csv");

interface ExpectedColumn {
  original: string;
  name: string;
  type: string;
}

const expected = JSON.parse(
  readFileSync(join(DIR, "expected.json"), "utf8"),
) as Record<string, ExpectedColumn[]>;

describe("messy-csv eval", () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith(".csv")).sort();
  it("covers all 10 eval files", () => {
    expect(files).toHaveLength(10);
  });

  let checked = 0;
  let correct = 0;
  const misses: string[] = [];

  for (const file of files) {
    it(`profiles ${file} as expected`, () => {
      const buf = readFileSync(join(DIR, file));
      const parsed = parseCsv(new Uint8Array(buf));
      const headers = sanitizeHeaders(parsed.headers);
      const profile = profileTable(headers, parsed.rows);

      const columns = expected[file];
      expect(columns, `expected.json entry for ${file}`).toBeTruthy();
      expect(profile.columns).toHaveLength(columns!.length);

      columns!.forEach((exp, i) => {
        const actual = profile.columns[i]!;
        checked += 1;
        const ok =
          actual.originalHeader.trim() === exp.original.trim() &&
          actual.columnName === exp.name &&
          actual.dataType === exp.type;
        if (ok) {
          correct += 1;
        } else {
          misses.push(
            `${file} [${exp.original}]: expected ${exp.name}:${exp.type}, got ${actual.columnName}:${actual.dataType}`,
          );
          expect.soft(
            `${actual.columnName}:${actual.dataType}`,
            `${file}[${exp.original}]`,
          ).toBe(`${exp.name}:${exp.type}`);
        }
      });
    });
  }

  it("achieves at least 90% type accuracy overall", () => {
    const accuracy = checked === 0 ? 0 : correct / checked;
    // printed for the eval report
    console.log(
      `\n[messy-csv] type accuracy: ${correct}/${checked} = ${(accuracy * 100).toFixed(1)}%`,
    );
    for (const m of misses) console.log(`  miss: ${m}`);
    expect(accuracy).toBeGreaterThanOrEqual(0.9);
  });
});
