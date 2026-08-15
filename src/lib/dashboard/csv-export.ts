/**
 * Client-side CSV generation for authorized, already-fetched dashboard rows.
 * This never fetches additional data — it only serializes what the current
 * page already rendered for the signed-in tenant/admin, so it can never leak
 * cross-tenant or unauthorized records.
 */
export type CsvColumn<T> = { header: string; value: (row: T) => string | number | null | undefined };

function escapeCsvCell(value: string | number | null | undefined): string {
  const text = value === null || value === undefined ? "" : String(value);
  if (/[",\n]/u.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

export function buildCsv<T>(rows: readonly T[], columns: readonly CsvColumn<T>[]): string {
  const lines = [columns.map((column) => escapeCsvCell(column.header)).join(",")];
  for (const row of rows) {
    lines.push(columns.map((column) => escapeCsvCell(column.value(row))).join(","));
  }
  return lines.join("\r\n");
}

export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
