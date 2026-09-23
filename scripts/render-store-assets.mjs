// Render reproducible Chrome Web Store graphics from the existing HTTPatch brand.
// Run after capturing the example-data popup: node scripts/render-store-assets.mjs
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'docs', 'store-assets');
const screenshotOutput = join(root, 'docs', 'screenshots');
await mkdir(output, { recursive: true });

const logo = (x, y, size) => `
  <g transform="translate(${x} ${y}) scale(${size / 128})">
    <rect width="128" height="128" rx="23" fill="#4f46e5"/>
    <path d="M32 32h17v25h30V32h17v64H79V73H49v23H32z" fill="#fff"/>
  </g>`;

const frame = (width, height, contents) => `<svg xmlns="http://www.w3.org/2000/svg"
  xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}"
  viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="background" x1="0" y1="0" x2="1" y2="1">
      <stop stop-color="#101827"/><stop offset="1" stop-color="#25205a"/>
    </linearGradient>
    <linearGradient id="accent" x1="0" y1="0" x2="1" y2="0">
      <stop stop-color="#817bff"/><stop offset="1" stop-color="#56d6e7"/>
    </linearGradient>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#background)"/>
  ${contents}
</svg>`;

const small = frame(
  440,
  280,
  `
  <circle cx="405" cy="-5" r="125" fill="#4f46e5" opacity=".13"/>
  <circle cx="413" cy="230" r="116" fill="#56d6e7" opacity=".07"/>
  <path d="M0 276H440" stroke="#817bff" stroke-width="8"/>
  ${logo(28, 32, 72)}
  <text x="116" y="81" fill="#fff" font-family="Arial,sans-serif" font-size="37"
    font-weight="700">HTTPatch</text>
  <text x="30" y="172" fill="#f4f4ff" font-family="Arial,sans-serif" font-size="23"
    font-weight="600">Shape your HTTP headers.</text>
  <text x="30" y="209" fill="#bfc6df" font-family="Arial,sans-serif" font-size="17">
    Profiles · Rules · Filters</text>
  <path d="M347 40h48m-48 17h30m-30 17h41" stroke="url(#accent)" stroke-width="5"
    stroke-linecap="round" opacity=".75"/>`,
);

const marquee = frame(
  1400,
  560,
  `
  <circle cx="1340" cy="15" r="310" fill="#4f46e5" opacity=".12"/>
  <circle cx="1100" cy="590" r="310" fill="#56d6e7" opacity=".06"/>
  <path d="M0 552H1400" stroke="#817bff" stroke-width="16"/>
  ${logo(78, 77, 104)}
  <text x="208" y="155" fill="#fff" font-family="Arial,sans-serif" font-size="72"
    font-weight="700">HTTPatch</text>
  <text x="80" y="280" fill="#f4f4ff" font-family="Arial,sans-serif" font-size="42"
    font-weight="600">Shape your HTTP headers.</text>
  <text x="82" y="344" fill="#bfc6df" font-family="Arial,sans-serif" font-size="27">
    Create profiles. Scope rules. Switch instantly.</text>
  <rect x="792" y="101" width="523" height="342" rx="22" fill="#202532"
    stroke="#57517d" stroke-width="2"/>
  <circle cx="827" cy="136" r="7" fill="#817bff"/>
  <text x="848" y="145" fill="#f4f4ff" font-family="Arial,sans-serif" font-size="23"
    font-weight="700">Example site</text>
  <rect x="1184" y="121" width="80" height="32" rx="16" fill="#4f46e5"/>
  <circle cx="1248" cy="137" r="12" fill="#fff"/>
  <path d="M816 174H1290" stroke="#3a4152" stroke-width="2"/>
  <rect x="821" y="205" width="107" height="43" rx="8" fill="#333c50"/>
  <text x="839" y="234" fill="#f4f4ff" font-family="Arial,sans-serif" font-size="18">Request</text>
  <rect x="939" y="205" width="81" height="43" rx="8" fill="#333c50"/>
  <text x="957" y="234" fill="#f4f4ff" font-family="Arial,sans-serif" font-size="18">Set</text>
  <rect x="821" y="266" width="469" height="57" rx="8" fill="#171c26"
    stroke="#4b5264"/>
  <text x="841" y="302" fill="#e5e9f7" font-family="Arial,sans-serif" font-size="21">
    X-HTTPatch-Test: working</text>
  <text x="822" y="384" fill="#aeb8d2" font-family="Arial,sans-serif" font-size="19">
    1 active rule · Manage profiles &amp; filters</text>`,
);

const popupBytes = await readFile(join(screenshotOutput, 'popup-site.png'));
const popupWidth = popupBytes.readUInt32BE(16);
const popupHeight = popupBytes.readUInt32BE(20);
const popup = popupBytes.toString('base64');
const popupStore = frame(
  1280,
  800,
  `
  <circle cx="1250" cy="-20" r="270" fill="#4f46e5" opacity=".11"/>
  <path d="M0 792H1280" stroke="#817bff" stroke-width="8"/>
  ${logo(72, 70, 86)}
  <text x="182" y="129" fill="#fff" font-family="Arial,sans-serif" font-size="54"
    font-weight="700">HTTPatch</text>
  <text x="74" y="256" fill="#f4f4ff" font-family="Arial,sans-serif" font-size="42"
    font-weight="600">Fast controls, right where</text>
  <text x="74" y="310" fill="#f4f4ff" font-family="Arial,sans-serif" font-size="42"
    font-weight="600">you browse.</text>
  <text x="76" y="401" fill="#bfc6df" font-family="Arial,sans-serif" font-size="27">
    Switch profiles</text>
  <text x="76" y="454" fill="#bfc6df" font-family="Arial,sans-serif" font-size="27">
    Edit header rules</text>
  <text x="76" y="507" fill="#bfc6df" font-family="Arial,sans-serif" font-size="27">
    Pause changes instantly</text>
  <rect x="745" y="90" width="420" height="${popupHeight + 32}" rx="19" fill="#090d17" opacity=".55"/>
  <rect x="761" y="106" width="${popupWidth}" height="${popupHeight}" rx="8" fill="#1b1d21"/>
  <image x="761" y="106" width="${popupWidth}" height="${popupHeight}"
    xlink:href="data:image/png;base64,${popup}"/>
  <text x="764" y="${popupHeight + 148}" fill="#bfc6df" font-family="Arial,sans-serif" font-size="20">
    Extension popup with example rule</text>`,
);

const browser = await chromium.launch({
  channel: process.platform === 'win32' ? 'chrome' : 'chromium',
});
try {
  for (const [name, width, height, svg, directory] of [
    ['promo-small', 440, 280, small, output],
    ['promo-marquee', 1400, 560, marquee, output],
    ['popup-store', 1280, 800, popupStore, screenshotOutput],
  ]) {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    await page.setContent(`<style>html,body{margin:0}</style>${svg}`);
    const path = join(directory, `${name}.png`);
    await page.screenshot({ path });
    await page.close();
    console.log(`wrote ${path} (${width}x${height})`);
  }
} finally {
  await browser.close();
}

await writeFile(join(output, 'promo-small.svg'), small);
await writeFile(join(output, 'promo-marquee.svg'), marquee);
