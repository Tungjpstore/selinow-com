// LP1 contrast audit — computes WCAG contrast ratios for the v3 light
// premium token pairs used across the landing page. Dev-time only.
const pairs = [
  ["ink #0E1526 on canvas #FFFFFF (hero title, headings)", 0x0e1526, 0xffffff],
  ["ink #0E1526 on canvas-deep #F5F7FB (bento/pricing panels)", 0x0e1526, 0xf5f7fb],
  ["ink-soft #46527A on #FFFFFF (body/lead)", 0x46527a, 0xffffff],
  ["ink-soft #46527A on #F5F7FB", 0x46527a, 0xf5f7fb],
  ["ink-muted #5A6485 on #FFFFFF (mono kickers, captions)", 0x5a6485, 0xffffff],
  ["accent-ink #5140C9 on #FFFFFF (links, kicker)", 0x5140c9, 0xffffff],
  ["accent-ink #5140C9 on #F5F7FB", 0x5140c9, 0xf5f7fb],
  ["white on accent-strong #6957DE (gradient CTA start)", 0xffffff, 0x6957de],
  ["white on indigo #5B5CEB (gradient CTA mid)", 0xffffff, 0x5b5ceb],
  ["white on indigo-hover #4F46E5 (gradient CTA end)", 0xffffff, 0x4f46e5],
  ["success-text #065F46 on success-surface #ECFDF5 (seal chip)", 0x065f46, 0xecfdf5],
];

function luminance(rgb) {
  const [r, g, b] = [rgb >> 16 & 255, rgb >> 8 & 255, rgb & 255].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

let failures = 0;
for (const [label, fg, bg] of pairs) {
  const r = ratio(fg, bg);
  const aa = r >= 4.5 ? "AA " : r >= 3 ? "AA-large" : "FAIL";
  if (r < 4.5) failures += 1;
  console.log(`${r.toFixed(2).padStart(6)}:1  ${aa.padEnd(8)} ${label}`);
}
console.log(failures === 0 ? "\nAll pairs ≥ 4.5:1 (AA for body text)." : `\n${failures} pair(s) below 4.5:1 — check usage size.`);
