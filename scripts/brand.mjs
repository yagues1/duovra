// Identidad de Duovra: dos rombos de cristal (los dos agentes) que se solapan; la zona común,
// más luminosa, es el espacio de trabajo compartido.
//
// Uso: node scripts/brand.mjs
//   → assets/brand/*.svg y *.png, src/assets/duovra-mark.svg y assets/brand/app-icon-1024.png
//     (origen de `tauri icon`).
import { Resvg } from '@resvg/resvg-js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'assets', 'brand');
mkdirSync(out, { recursive: true });

const SIDE = 330;
const RX = 66;
const rhomb = (cx, cy = 512) =>
  `<rect x="${cx - SIDE / 2}" y="${cy - SIDE / 2}" width="${SIDE}" height="${SIDE}" rx="${RX}" transform="rotate(45 ${cx} ${cy})"/>`;
const A = 420;
const B = 604;

function mark({ light = false, id = 'dv' } = {}) {
  return `
  <defs>
    <linearGradient id="${id}-a" gradientUnits="userSpaceOnUse" x1="190" y1="280" x2="650" y2="745">
      <stop offset="0" stop-color="${light ? '#16A6CF' : '#8DF0FF'}"/>
      <stop offset="1" stop-color="${light ? '#0B6FA8' : '#22B4DA'}"/>
    </linearGradient>
    <linearGradient id="${id}-b" gradientUnits="userSpaceOnUse" x1="375" y1="280" x2="835" y2="745">
      <stop offset="0" stop-color="${light ? '#6C66EA' : '#B9A8FF'}"/>
      <stop offset="1" stop-color="${light ? '#3B44C4' : '#5F6CF2'}"/>
    </linearGradient>
    <linearGradient id="${id}-c" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#FFFFFF"/>
      <stop offset="1" stop-color="${light ? '#CFE9FF' : '#BFEFFF'}"/>
    </linearGradient>
    <linearGradient id="${id}-hi" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#FFFFFF" stop-opacity="0.55"/>
      <stop offset="0.45" stop-color="#FFFFFF" stop-opacity="0"/>
    </linearGradient>
    <clipPath id="${id}-clip-b">${rhomb(B)}</clipPath>
  </defs>
  <g fill="url(#${id}-a)">${rhomb(A)}</g>
  <g fill="url(#${id}-b)" opacity="0.94">${rhomb(B)}</g>
  <g fill="url(#${id}-c)" clip-path="url(#${id}-clip-b)">${rhomb(A)}</g>
  <g fill="url(#${id}-hi)" opacity="0.6">${rhomb(A)}${rhomb(B)}</g>`;
}

function tile(light = false) {
  return `
  <defs>
    <linearGradient id="dv-tile" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${light ? '#F6F9FF' : '#12285C'}"/>
      <stop offset="0.55" stop-color="${light ? '#E7EEFB' : '#0A1838'}"/>
      <stop offset="1" stop-color="${light ? '#D9E3F6' : '#050B1E'}"/>
    </linearGradient>
    <radialGradient id="dv-glow" cx="0.5" cy="0.92" r="0.62">
      <stop offset="0" stop-color="${light ? '#9FDFFF' : '#2FC6E6'}" stop-opacity="${light ? 0.35 : 0.3}"/>
      <stop offset="1" stop-color="#2FC6E6" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="dv-rim" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#FFFFFF" stop-opacity="${light ? 0.95 : 0.55}"/>
      <stop offset="0.35" stop-color="#BFE4FF" stop-opacity="0.08"/>
      <stop offset="0.8" stop-color="#9FD4FF" stop-opacity="0.08"/>
      <stop offset="1" stop-color="#CFEFFF" stop-opacity="${light ? 0.6 : 0.4}"/>
    </linearGradient>
  </defs>
  <rect x="24" y="24" width="976" height="976" rx="226" fill="url(#dv-tile)"/>
  <rect x="24" y="24" width="976" height="976" rx="226" fill="url(#dv-glow)"/>
  <rect x="30" y="30" width="964" height="964" rx="220" fill="none" stroke="url(#dv-rim)" stroke-width="12"/>`;
}

const svg = (body, vb = '0 0 1024 1024') => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}">${body}\n</svg>\n`;

const files = {
  // Símbolo sobre baldosa de cristal: icono de la aplicación.
  'duovra-icon.svg': svg(tile() + `<g transform="translate(512 512) scale(1.04) translate(-512 -512)">${mark()}</g>`),
  'duovra-icon-light.svg': svg(tile(true) + `<g transform="translate(512 512) scale(1.04) translate(-512 -512)">${mark({ light: true })}</g>`),
  // Símbolo sin baldosa, para fondos oscuros y claros.
  'duovra-mark.svg': svg(mark(), '170 270 684 484'),
  'duovra-mark-light.svg': svg(mark({ light: true }), '170 270 684 484'),
  // Variante para tamaños pequeños (16–32 px): trazo más grueso.
  'duovra-icon-small.svg': svg(tile() + `<g transform="translate(512 512) scale(1.12) translate(-512 -512)">${mark()}</g>`),
};

const wordmark = (light) => svg(`
  <g transform="translate(0 0) scale(0.25)">${mark({ light })}</g>
  <text x="232" y="160" font-family="Geist, 'Segoe UI', sans-serif" font-size="104" font-weight="600" letter-spacing="-2" fill="${light ? '#0B1735' : '#EEF6FF'}">Duovra</text>`, '40 60 620 140');
files['duovra-wordmark.svg'] = wordmark(false);
files['duovra-wordmark-light.svg'] = wordmark(true);

for (const [name, content] of Object.entries(files)) writeFileSync(join(out, name), content);
writeFileSync(join(root, 'src', 'assets', 'duovra-mark.svg'), files['duovra-mark.svg']);

const png = (content, size) => new Resvg(content, { fitTo: { mode: 'width', value: size } }).render().asPng();
writeFileSync(join(out, 'app-icon-1024.png'), png(files['duovra-icon.svg'], 1024));
writeFileSync(join(out, 'duovra-icon-256.png'), png(files['duovra-icon.svg'], 256));
writeFileSync(join(out, 'duovra-icon-32.png'), png(files['duovra-icon-small.svg'], 32));
writeFileSync(join(out, 'duovra-icon-light-256.png'), png(files['duovra-icon-light.svg'], 256));
console.log('Identidad generada en assets/brand/');
