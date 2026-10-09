import type { ColumnProfile } from "./profile";

export interface TableLike {
  tableName: string;
  columns: ColumnProfile[];
}

export interface DetectedRelationship {
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
  overlap: number;
  method: "name+overlap";
}

const OVERLAP_THRESHOLD = 0.9;

function singular(table: string): string {
  return table.endsWith("s") && table.length > 1 ? table.slice(0, -1) : table;
}

function typesCompatible(a: string, b: string): boolean {
  if (a === b) return true;
  const numeric = new Set(["integer", "decimal"]);
  return numeric.has(a) && numeric.has(b);
}

/**
 * A child column matches a parent key when:
 *  - names are identical (child.fk_col == parent.pk_col), or
 *  - the child is named <parent_table>_<key> or <singular(parent_table)>_<key>
 *    (e.g. orders.customer_id -> customers.id), and
 *  - types are compatible, and
 *  - >= 90% of the child's distinct non-null values exist in the parent key.
 */
export function detectRelationships(tables: TableLike[]): DetectedRelationship[] {
  const found: DetectedRelationship[] = [];
  const seen = new Set<string>();

  for (const child of tables) {
    for (const parent of tables) {
      if (parent.tableName === child.tableName) continue;
      const parentKeys = parent.columns.filter(
        (c) => c.isCandidateKey && c.distinctValues !== null,
      );
      if (parentKeys.length === 0) continue;

      for (const childCol of child.columns) {
        if (childCol.distinctValues === null || childCol.distinctValues.length === 0) {
          continue;
        }
        for (const keyCol of parentKeys) {
          const nameMatches =
            childCol.columnName === keyCol.columnName ||
            childCol.columnName === `${parent.tableName}_${keyCol.columnName}` ||
            childCol.columnName ===
              `${singular(parent.tableName)}_${keyCol.columnName}`;
          if (!nameMatches) continue;
          if (!typesCompatible(childCol.dataType, keyCol.dataType)) continue;

          const parentSet = new Set(keyCol.distinctValues);
          const hits = childCol.distinctValues.filter((v) => parentSet.has(v)).length;
          const overlap = hits / childCol.distinctValues.length;
          if (overlap < OVERLAP_THRESHOLD) continue;

          const signature = `${child.tableName}.${childCol.columnName}->${parent.tableName}.${keyCol.columnName}`;
          if (seen.has(signature)) continue;
          seen.add(signature);
          found.push({
            fromTable: child.tableName,
            fromColumn: childCol.columnName,
            toTable: parent.tableName,
            toColumn: keyCol.columnName,
            overlap: Math.round(overlap * 1000) / 1000,
            method: "name+overlap",
          });
        }
      }
    }
  }
  return found;
}
