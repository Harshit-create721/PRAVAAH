const { Resvg } = require('@resvg/resvg-js');
const fs = require('node:fs');
const path = require('node:path');
// Lucide activity mark, retrieved with Better Icons. ISC licensed; see THIRD_PARTY.md.
const line = 'M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2';
const foreground = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><g transform="translate(242 242) scale(22.5)" fill="none" stroke="#E0A03C" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="${line}"/></g></svg>`;
const icon = foreground.replace('<g ', '<rect width="1024" height="1024" fill="#080A0D"/><rect x="80" y="80" width="864" height="864" rx="150" fill="#12151A" stroke="#2B3038" stroke-width="4"/><g ');
const dir = path.resolve(__dirname, '../assets');
for (const [name, svg] of [['icon', icon], ['adaptive-icon', foreground], ['notification-icon', foreground.replace('#E0A03C', '#FFFFFF')]]) {
  fs.writeFileSync(path.join(dir, `${name}.svg`), svg);
  fs.writeFileSync(path.join(dir, `${name}.png`), new Resvg(svg).render().asPng());
}
