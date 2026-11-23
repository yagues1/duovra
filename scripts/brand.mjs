// Regenera los recursos desde los SVG aprobados de V2 Dominó guardados en assets/brand.
import { Resvg } from '@resvg/resvg-js';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const brand = join(root, 'assets', 'brand');
const icons = join(root, 'src-tauri', 'icons');
const master = join(brand, 'duovra-icon.svg');
const dark = readFileSync(master, 'utf8');
const light = readFileSync(join(brand, 'duovra-icon-light.svg'), 'utf8');

const render = (svg, size) => new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng();

// El símbolo de la interfaz va sobre el fondo de la app. Solo se recorta el área
// transparente para conservar el encuadre que usa la barra de título.
function transparentMark(icon) {
  const mark = icon
    .replace(' width="256" height="256" viewBox="0 0 256 256"', ' viewBox="28 28 200 200"')
    .replace(/<rect width="256" height="256" fill="#[0-9A-F]{6}"\/>/, '<title>Duovra</title>');
  return mark.trimEnd() + '\n';
}

function windowsIcon() {
  // Tauri no incluye 128 px en el ICO que genera. Renderizamos cada tamaño desde el SVG.
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const header = Buffer.alloc(6 + 16 * sizes.length);
  header.writeUInt16LE(1, 2); // Tipo ICO.
  header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;

  const frames = sizes.map((size, index) => {
    const png = render(dark, size);
    const entry = 6 + 16 * index;
    const dimension = size === 256 ? 0 : size;
    header.writeUInt8(dimension, entry);
    header.writeUInt8(dimension, entry + 1);
    header.writeUInt16LE(1, entry + 4); // Un plano de color.
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(png.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += png.length;
    return png;
  });

  return Buffer.concat([header, ...frames]);
}

const output = join(root, 'output');
mkdirSync(output, { recursive: true });
const staging = mkdtempSync(join(output, 'tauri-icons-'));
try {
  const cli = join(root, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
  execFileSync(process.execPath, [cli, 'icon', master, '-o', staging], { cwd: root });

  for (const file of readdirSync(staging, { withFileTypes: true })) {
    if (file.isFile() && file.name !== 'icon.ico') {
      copyFileSync(join(staging, file.name), join(icons, file.name));
    }
  }
} finally {
  rmSync(staging, { recursive: true, force: true });
}

const large = render(dark, 1024);
const mark = transparentMark(dark);
writeFileSync(join(icons, 'app-icon.png'), large);
writeFileSync(join(icons, 'icon.ico'), windowsIcon());
writeFileSync(join(brand, 'app-icon-1024.png'), large);
writeFileSync(join(brand, 'duovra-icon-256.png'), render(dark, 256));
writeFileSync(join(brand, 'duovra-icon-32.png'), render(dark, 32));
writeFileSync(join(brand, 'duovra-icon-light-256.png'), render(light, 256));
writeFileSync(join(brand, 'duovra-icon-small.svg'), dark);
writeFileSync(join(brand, 'duovra-mark.svg'), mark);
writeFileSync(join(brand, 'duovra-mark-light.svg'), transparentMark(light));
writeFileSync(join(root, 'src', 'assets', 'duovra-mark.svg'), mark);
console.log('Iconos de Duovra generados en assets/brand y src-tauri/icons.');
