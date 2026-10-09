import ExcelJS from "exceljs";
import Papa from "papaparse";

export interface ParsedFile {
  /** First row (raw headers). */
  headers: string[];
  /** Data rows as raw strings. */
  rows: string[][];
}

/** Decode as UTF-8, falling back to Windows-1252 when decoding fails. */
export function decodeBuffer(buf: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder("windows-1252").decode(buf);
  }
}

export function parseCsv(buf: Uint8Array): ParsedFile {
  const text = decodeBuffer(buf);
  const result = Papa.parse<string[]>(text, {
    skipEmptyLines: "greedy",
  });
  if (result.errors.length > 0 && result.data.length === 0) {
    throw new Error(`CSV parse failed: ${result.errors[0]?.message ?? "unknown"}`);
  }
  const data = result.data;
  const headers = (data[0] ?? []).map((h) => (h ?? "").toString());
  const rows = data.slice(1).map((r) => r.map((c) => (c ?? "").toString()));
  return { headers, rows };
}

function excelCellToString(cell: ExcelJS.Cell): string {
  const v = cell.value;
  if (v === null || v === undefined) return "";
  if (v instanceof Date) {
    const iso = v.toISOString();
    const time = iso.slice(11, 19);
    return time === "00:00:00" ? iso.slice(0, 10) : iso.slice(0, 19).replace("T", " ");
  }
  if (typeof v === "object") {
    if ("richText" in v && Array.isArray(v.richText)) {
      return v.richText.map((r) => r.text).join("");
    }
    if ("result" in v) {
      const r = v.result;
      if (r instanceof Date) {
        const iso = r.toISOString();
        return iso.slice(11, 19) === "00:00:00"
          ? iso.slice(0, 10)
          : iso.slice(0, 19).replace("T", " ");
      }
      return r === null || r === undefined ? "" : String(r);
    }
    if ("text" in v) return String(v.text);
    if ("hyperlink" in v && "text" in v) return String(v.text);
    return String(v);
  }
  return String(v);
}

/** First sheet only; dates as ISO strings. */
export async function parseXlsx(buf: Uint8Array): Promise<ParsedFile> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const ws = wb.worksheets[0];
  if (!ws) return { headers: [], rows: [] };
  const allRows: string[][] = [];
  ws.eachRow((row) => {
    const cells: string[] = [];
    const values = row.values as ExcelJS.CellValue[];
    // row.values is 1-indexed
    for (let i = 1; i < values.length; i += 1) {
      cells.push(excelCellToString(row.getCell(i)));
    }
    allRows.push(cells);
  });
  const headers = allRows[0] ?? [];
  return { headers, rows: allRows.slice(1) };
}

export async function parseTabularFile(
  fileName: string,
  buf: Uint8Array,
): Promise<ParsedFile> {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".csv")) return parseCsv(buf);
  if (lower.endsWith(".xlsx")) return parseXlsx(buf);
  throw new Error(`Unsupported file type: ${fileName} (CSV and XLSX only)`);
}
