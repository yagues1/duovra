import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

function initial(dir) {
  const html = readFileSync(join(dir, 'index.html'), 'utf8');
  const refs = Array.from(html.matchAll(/(?:src|href)="\/(assets\/[^"]+\.(?:js|css))"/g), ([, path]) => path);
  const files = [...new Set(refs)].map((path) => {
    const contents = readFileSync(join(dir, path));
    return { path, bytes: contents.length, gzipBytes: gzipSync(contents).length };
  });
  assert(files.length && !files.some(({ path }) => /mermaid|VisualViewer|html-|svg-|InteractiveFence|WidgetPreview|WidgetViewer/.test(path)));
  return { files, bytes: files.reduce((sum, file) => sum + file.bytes, 0),
    gzipBytes: files.reduce((sum, file) => sum + file.gzipBytes, 0) };
}
const [base, after] = process.argv.slice(2);
assert(base && after, 'Indica las dos carpetas del build de Vite.');
const lazyWidgets = readdirSync(join(after, 'assets')).filter((name) => /^(InteractiveFence|WidgetPreview|WidgetViewer)-/.test(name))
  .map((name) => {
    const contents = readFileSync(join(after, 'assets', name));
    return { name, bytes: contents.length, gzipBytes: gzipSync(contents).length };
  });
console.log(JSON.stringify({ base: initial(base), after: initial(after), lazyWidgets }, null, 2));
