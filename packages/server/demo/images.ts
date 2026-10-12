// The demo's images, drawn as SVG and rendered to JPEG in Chromium so nothing binary is kept in
// git. They contain no text, so they look the same whatever fonts the machine has.
import type { Browser } from "playwright";

export interface DemoFile {
  name: string;
  mimeType: string;
  buffer: Buffer;
}

const W = 1920;
const H = 1080;

/** Deterministic pseudo-random numbers, so the scattered shapes stay put between runs. */
function random(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1_103_515_245 + 12_345) % 2_147_483_648;
    return s / 2_147_483_648;
  };
}

const svg = (body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${body}</svg>`;

/** Deep purple with soft light blobs: the theme background. */
function background() {
  const r = random(1);
  const blobs = Array.from({ length: 14 }, () => {
    const color = ["#ff5fa2", "#7b5cff", "#38d6ff"][Math.floor(r() * 3)];
    return `<circle cx="${r() * W}" cy="${r() * H}" r="${120 + r() * 260}" fill="${color}" opacity="${0.08 + r() * 0.14}"/>`;
  }).join("");
  return svg(`
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#140c2e"/><stop offset="1" stop-color="#2a0f3d"/>
      </linearGradient>
      <filter id="blur"><feGaussianBlur stdDeviation="60"/></filter>
    </defs>
    <rect width="${W}" height="${H}" fill="url(#g)"/>
    <g filter="url(#blur)">${blobs}</g>`);
}

/** A stage under a synthwave sun with a perspective grid. */
function stage() {
  const lines = Array.from({ length: 24 }, (_, i) => {
    const x = (i - 11.5) * 220;
    return `<line x1="${W / 2 + x * 0.08}" y1="620" x2="${W / 2 + x * 1.6}" y2="${H}" />`;
  }).join("");
  const rows = Array.from({ length: 9 }, (_, i) => {
    const y = 620 + (H - 620) * ((i + 1) / 9) ** 1.8;
    return `<line x1="0" y1="${y}" x2="${W}" y2="${y}" />`;
  }).join("");
  return svg(`
    <defs>
      <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#0b0420"/><stop offset="1" stop-color="#5a1460"/>
      </linearGradient>
      <linearGradient id="sun" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#ffd36b"/><stop offset="1" stop-color="#ff3f8e"/>
      </linearGradient>
    </defs>
    <rect width="${W}" height="${H}" fill="url(#sky)"/>
    <circle cx="${W / 2}" cy="560" r="300" fill="url(#sun)"/>
    ${Array.from({ length: 6 }, (_, i) => `<rect x="0" y="${380 + i * 42}" width="${W}" height="${6 + i * 3}" fill="#3a0f4a"/>`).join("")}
    <rect y="620" width="${W}" height="${H - 620}" fill="#12051f"/>
    <g stroke="#ff5fa2" stroke-width="2" opacity="0.8">${lines}${rows}</g>`);
}

/** A dark hall full of screens. */
function hall() {
  const r = random(7);
  const screens = Array.from({ length: 70 }, (_, i) => {
    const row = Math.floor(i / 10);
    const x = 60 + (i % 10) * 185 + r() * 30;
    const y = 520 + row * 80;
    const w = 90 + row * 6;
    const color = ["#38d6ff", "#7b5cff", "#ff5fa2", "#a3ffcb"][Math.floor(r() * 4)];
    return `<rect x="${x}" y="${y}" width="${w}" height="${w * 0.6}" rx="4" fill="${color}" opacity="${0.35 + r() * 0.5}"/>`;
  }).join("");
  const beams = Array.from({ length: 5 }, (_, i) => {
    const x = 200 + i * 380;
    return `<polygon points="${x},0 ${x + 40},0 ${x + 260},${H} ${x - 180},${H}" fill="#7b5cff" opacity="0.08"/>`;
  }).join("");
  return svg(`
    <rect width="${W}" height="${H}" fill="#07040f"/>
    <rect x="460" y="80" width="1000" height="360" rx="8" fill="#1d1640"/>
    <rect x="480" y="100" width="960" height="320" fill="#38d6ff" opacity="0.5"/>
    ${beams}${screens}`);
}

/** Northern lights over a lake. */
function lake() {
  const r = random(3);
  const stars = Array.from({ length: 160 }, () => {
    return `<circle cx="${r() * W}" cy="${r() * 560}" r="${0.8 + r() * 1.8}" fill="#fff" opacity="${0.3 + r() * 0.7}"/>`;
  }).join("");
  const aurora = (y: number, color: string, opacity: number) =>
    `<path d="M0 ${y} C 400 ${y - 220}, 900 ${y + 160}, 1300 ${y - 120} S 1800 ${y - 60}, ${W} ${y - 200} L ${W} ${y + 80} C 1500 ${y + 40}, 900 ${y + 260}, 0 ${y + 140} Z" fill="${color}" opacity="${opacity}"/>`;
  return svg(`
    <defs>
      <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#020617"/><stop offset="1" stop-color="#0b2a3a"/>
      </linearGradient>
      <filter id="blur"><feGaussianBlur stdDeviation="40"/></filter>
    </defs>
    <rect width="${W}" height="${H}" fill="url(#sky)"/>
    ${stars}
    <g filter="url(#blur)">
      ${aurora(360, "#3dffb0", 0.45)}${aurora(300, "#38d6ff", 0.3)}${aurora(420, "#7b5cff", 0.3)}
    </g>
    <polygon points="0,700 220,560 420,690 640,540 900,700 1200,580 1500,700 1720,600 ${W},680 ${W},760 0,760" fill="#030a12"/>
    <rect y="760" width="${W}" height="${H - 760}" fill="#05141f"/>
    <g filter="url(#blur)" transform="translate(0 1520) scale(1 -1)" opacity="0.35">
      ${aurora(360, "#3dffb0", 0.45)}
    </g>`);
}

const images: Record<string, () => string> = {
  "background.jpg": background,
  "photo-stage.jpg": stage,
  "photo-hall.jpg": hall,
  "photo-lake.jpg": lake,
};

/** Renders every image to a JPEG. */
export async function renderImages(browser: Browser): Promise<DemoFile[]> {
  const context = await browser.newContext({ viewport: { width: W, height: H } });
  const page = await context.newPage();
  const files: DemoFile[] = [];
  for (const [name, draw] of Object.entries(images)) {
    await page.setContent(
      `<!doctype html><style>html,body{margin:0;background:#000}svg{display:block}</style>${draw()}`,
    );
    const buffer = await page.screenshot({ type: "jpeg", quality: 88 });
    files.push({ name, mimeType: "image/jpeg", buffer });
  }
  await context.close();
  return files;
}
