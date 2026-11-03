// A QR code for a Stellar address, as SVG.
//
// Why this exists: a Stellar account address is 56 characters of base32
// (A–Z and 2–7). Asking a human to retype one is how money gets lost. Most
// typos fail the account's own checksum and get rejected, but not all of them:
// enough wrong characters can land on a different account that is perfectly
// valid and belongs to someone else. A scanned code removes the transcription
// step entirely, which is also what fixed the "exchange says this address is
// invalid" problem — the paste was never the issue, the exchange's address
// field was.
//
// SVG rather than PNG: it stays crisp at any size, it is a fraction of the
// bytes, and it can be served as its own route so the page keeps a strict CSP
// (img-src 'self') instead of a giant inline data URI.
import qrcode from "qrcode-generator";

/**
 * Render `text` as a standalone SVG QR code.
 *
 * `dark`/`light` follow the page it sits on. A QR on a dark background needs a
 * light quiet zone or some scanners struggle with the contrast inversion, so
 * the module colour stays dark and the background stays light by default.
 */
export function qrSvg(text: string, opts: { cell?: number; dark?: string; light?: string } = {}): string {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const cell = opts.cell ?? 4;
  const dark = opts.dark ?? "#0f1315";
  const light = opts.light ?? "#ffffff";
  const n = qr.getModuleCount();
  const size = n * cell;
  // One path of rectangles rather than n^2 <rect> elements: a 33x33 code is
  // ~1k path commands instead of ~110k bytes of markup.
  let d = "";
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!qr.isDark(r, c)) continue;
      // Extend right while the run stays dark: fewer path segments.
      let w = 1;
      while (c + w < n && qr.isDark(r, c + w)) w++;
      d += `M${c * cell} ${r * cell}h${w * cell}v${cell}h-${w * cell}z`;
      c += w - 1;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" `
    + `viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" `
    + `aria-label="QR code for ${text}">`
    + `<rect width="${size}" height="${size}" fill="${light}"/>`
    + `<path d="${d}" fill="${dark}"/></svg>`;
}
