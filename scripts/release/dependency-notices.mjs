// Reúne los avisos que publican los paquetes fijados por los lockfiles.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const noticeName = /^(?:licen[cs]e|copying|notice|copyright|third[ _-]?party[ _-]?notices)(?:[.\-_]|$)/i;

export function windowsCargoPackages(root) {
  const env = { ...process.env };
  const bin = join(homedir(), '.cargo', 'bin');
  if (existsSync(bin)) env.PATH = `${bin};${env.PATH ?? env.Path ?? ''}`;
  delete env.Path;
  const run = (program, args) => execFileSync(program, args, { cwd: root, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const target = /^host: (.+)$/m.exec(run('rustc', ['-vV']))?.[1]?.trim();
  return JSON.parse(run('cargo', [
    'metadata', '--format-version', '1', '--locked', '--filter-platform', target, '--manifest-path', 'src-tauri/Cargo.toml',
  ])).packages.filter((pkg) => pkg.source);
}

export function dependencyNotices(root, cargoPackages) {
  const readTexts = (directory) => readdirSync(directory, { withFileTypes: true })
    .filter((file) => file.isFile() && noticeName.test(file.name))
    .map((file) => join(directory, file.name));
  const npm = Object.entries(readJson(join(root, 'package-lock.json')).packages)
    .filter(([path, info]) => path && !info.dev && existsSync(join(root, path, 'package.json')))
    .map(([path, info]) => {
      const directory = join(root, path);
      const { name, version, license } = readJson(join(directory, 'package.json'));
      return { name, version, license, source: info.resolved, files: readTexts(directory) };
    });
  const cargo = cargoPackages.map((pkg) => {
    const directory = dirname(pkg.manifest_path);
    const files = readTexts(directory);
    if (pkg.license_file) files.push(resolve(directory, pkg.license_file));
    const { name, version, license } = pkg;
    return { name, version, license, source: `https://static.crates.io/crates/${name}/${name}-${version}.crate`, files };
  });

  const texts = new Map();
  const describe = ({ name, version, license, source, files }) => {
    const references = files.map((file) => {
      const content = readFileSync(file, 'utf8').trim().replace(/\r\n/g, '\n');
      if (!texts.has(content)) texts.set(content, texts.size + 1);
      return texts.get(content);
    });
    const terms = references.length ? ` [texts ${[...new Set(references)].join(', ')}]` : '';
    return `${name} ${version} · ${license ?? 'see the published package'}${terms}\n  ${source}\n`;
  };
  const inventory = [...npm, ...cargo].sort((a, b) => a.name.localeCompare(b.name, 'en')).map(describe);
  return [
    'Duovra · Dependency notices',
    'This inventory includes npm production packages and the Windows Cargo dependency graph.',
    'Project assets, upstream source links and additional terms appear in third-party-notices.txt.',
    '',
    ...inventory,
    ...Array.from(texts, ([content, index]) => `--- License text ${index} ---\n\n${content}\n`),
  ].join('\n');
}
