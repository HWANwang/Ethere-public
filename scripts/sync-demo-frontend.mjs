import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const source = fileURLToPath(new URL('../web/', import.meta.url));
const target = fileURLToPath(new URL('../docs/app/', import.meta.url));
await mkdir(target, { recursive: true });

for (const file of await readdir(source)) {
  if (['index.html', 'companion-api.js', 'manifest.webmanifest'].includes(file)) continue;
  await copyFile(join(source, file), join(target, file));
}

const manifest = JSON.parse(await readFile(join(source, 'manifest.webmanifest'), 'utf8'));
manifest.icons = [{ src: './brand-icon.png', sizes: '192x192', type: 'image/png', purpose: 'any' }];
await writeFile(join(target, 'manifest.webmanifest'), `${JSON.stringify(manifest, null, 2)}\n`);

const html = (await readFile(join(source, 'index.html'), 'utf8'))
  .replace('<link rel="stylesheet" href="./styles.css">', '<link rel="stylesheet" href="./styles.css">\n    <link rel="stylesheet" href="./demo.css">')
  .replace('<link rel="icon" href="./icon.svg" type="image/svg+xml">', '<link rel="icon" href="./brand-icon.png" type="image/png">')
  .replace('<img src="./icon.svg" alt="" aria-hidden="true">', '<img src="./brand-icon.png" alt="" aria-hidden="true">')
  .replace('<script type="module" src="./app.js"></script>', '<script type="module" src="./app.js"></script>\n    <script type="module" src="./demo-bridge.js"></script>');
await writeFile(join(target, 'index.html'), html);
