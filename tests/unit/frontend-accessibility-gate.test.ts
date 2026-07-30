import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

const roots = ["src/pages", "src/layouts", "src/components"];
const interactiveTags = ["a", "button", "input", "select", "textarea"] as const;

type ElementMatch = {
  file: string;
  line: number;
  opening: string;
  body: string;
  tag: (typeof interactiveTags)[number];
};

async function astroFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return astroFiles(path);
    return entry.name.endsWith(".astro") ? [path] : [];
  }));
  return files.flat();
}

function lineAt(source: string, offset: number): number {
  return source.slice(0, offset).split("\n").length;
}

function attribute(opening: string, name: string): string | null {
  const pattern = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|\\{([^}]*)\\})`, "iu");
  const match = opening.match(pattern);
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

function hasAttribute(opening: string, name: string): boolean {
  return new RegExp(`\\b${name}\\s*=`, "iu").test(opening);
}

function hasAccessibleName(opening: string, body: string): boolean {
  if (attribute(opening, "aria-hidden") === "true") return true;
  if (hasAttribute(opening, "aria-label") || hasAttribute(opening, "aria-labelledby")) return true;
  // A runtime expression can render a valid name even when no literal text is present.
  const text = body.replace(/<[^>]*>/gu, " ").replace(/&[a-z0-9#]+;/giu, " ").trim();
  return text.length > 0 || /\{[\s\S]*\}/u.test(body);
}

function collectElements(file: string, source: string, tag: (typeof interactiveTags)[number]): ElementMatch[] {
  const matches: ElementMatch[] = [];
  const elementPattern = new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)<\\/${tag}>`, "giu");
  let match: RegExpExecArray | null;
  while ((match = elementPattern.exec(source)) !== null) {
    matches.push({
      body: match[2] ?? "",
      file,
      line: lineAt(source, match.index),
      opening: `<${tag}${match[1] ?? ""}>`,
      tag,
    });
  }

  // Void controls (inputs and custom Astro branches) do not have a closing tag.
  if (tag === "input") {
    const voidPattern = /<input\b[^>]*>/giu;
    let voidMatch: RegExpExecArray | null;
    while ((voidMatch = voidPattern.exec(source)) !== null) {
      if (matches.some((item) => item.line === lineAt(source, voidMatch?.index ?? 0) && item.tag === tag)) continue;
      matches.push({
        body: "",
        file,
        line: lineAt(source, voidMatch.index),
        opening: voidMatch[0],
        tag,
      });
    }
  }
  return matches;
}

function elementDescription(match: ElementMatch): string {
  return `${relative(process.cwd(), match.file)}:${String(match.line)} <${match.tag}>`;
}

describe("frontend accessibility and keyboard gate", () => {
  it("keeps images, links, buttons and form controls semantically named", async () => {
    const files = (await Promise.all(roots.map((root) => astroFiles(root)))).flat();
    const sources = await Promise.all(files.map(async (file) => ({ file, source: await readFile(file, "utf8") })));
    const failures: string[] = [];

    for (const { file, source } of sources) {
      const imagePattern = /<img\b[^>]*>/giu;
      let image: RegExpExecArray | null;
      while ((image = imagePattern.exec(source)) !== null) {
        if (!hasAttribute(image[0], "alt")) failures.push(`${relative(process.cwd(), file)}:${String(lineAt(source, image.index))} <img> is missing alt`);
      }

      for (const tag of interactiveTags) {
        for (const match of collectElements(file, source, tag)) {
          if (tag === "a") {
            if (!hasAttribute(match.opening, "href")) failures.push(`${elementDescription(match)} is missing href`);
            if (!hasAccessibleName(match.opening, match.body)) failures.push(`${elementDescription(match)} has no accessible name`);
          }
          if (tag === "button") {
            if (!hasAttribute(match.opening, "type")) failures.push(`${elementDescription(match)} must declare type`);
            if (!hasAccessibleName(match.opening, match.body)) failures.push(`${elementDescription(match)} has no accessible name`);
          }
          if (["input", "select", "textarea"].includes(tag)) {
            const id = attribute(match.opening, "id");
            const hasExplicitLabel = hasAttribute(match.opening, "aria-label") || hasAttribute(match.opening, "aria-labelledby");
            const hasForLabel = id !== null && new RegExp(`<label\\b[^>]*\\bfor\\s*=\\s*["']${id}["']`, "iu").test(source);
            const wrappedByLabel = source.slice(0, source.indexOf(match.opening)).lastIndexOf("<label") > source.slice(0, source.indexOf(match.opening)).lastIndexOf("</label>");
            if (!hasExplicitLabel && !hasForLabel && !wrappedByLabel) failures.push(`${elementDescription(match)} has no associated label`);
          }
        }
      }
    }

    expect(failures, failures.join("\n")).toEqual([]);
  });

  it("keeps keyboard focus and the single tenant-context contract explicit", async () => {
    const [a11y, appShell, storefront, platform, domainManager, domainsPage] = await Promise.all([
      readFile("src/styles/selinow-a11y.css", "utf8"),
      readFile("src/styles/app-shell.css", "utf8"),
      readFile("src/styles/storefront.css", "utf8"),
      readFile("src/styles/platform.css", "utf8"),
      readFile("src/components/dashboard/DomainManager.astro", "utf8"),
      readFile("src/pages/app/domains.astro", "utf8"),
    ]);

    for (const [name, css] of [["a11y", a11y], ["app shell", appShell], ["storefront", storefront], ["platform", platform]] as const) {
      expect(css, `${name} must define a visible focus style`).toMatch(/:focus-visible/iu);
    }
    expect(a11y, "shared focus styles must honor reduced motion").toMatch(/prefers-reduced-motion/iu);
    expect(domainManager).not.toContain('role="tablist"');
    expect(domainManager).not.toContain("data-shop-tab");
    expect(domainManager).toContain("data-shop-id={shop?.publicId}");
    expect(domainManager).toContain("data-shop-timezone={shop?.timezone}");
    expect(domainsPage).toContain("shop={selectedShop}");

    const positiveTabIndex = /\btabindex\s*=\s*["']([1-9][0-9]*)["']/giu;
    expect(`${appShell}\n${storefront}\n${platform}\n${domainManager}`).not.toMatch(positiveTabIndex);
  });

  it("lets checkout grid children shrink without mobile horizontal overflow", async () => {
    const storefront = await readFile("src/styles/storefront.css", "utf8");

    expect(storefront).toMatch(/\.checkout-grid\s*>\s*\*\s*\{\s*min-width:\s*0;\s*\}/u);
  });
});
