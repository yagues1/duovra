import { createServer } from 'vite';
import { resolve } from 'node:path';

const [source = '.', rawPort = '1422'] = process.argv.slice(2);
const port = Number(rawPort);
const server = await createServer({
  root: resolve(source),
  cacheDir: resolve('output/qa/liquid-glass', `cache-${port}`),
  server: {
    host: '127.0.0.1',
    port,
    strictPort: true,
    watch: { ignored: ['**/output/**'] },
    hmr: false,
    fs: { allow: [resolve('.')] },
  },
  optimizeDeps: { entries: ['index.html'], include: ['@tauri-apps/api/mocks'] },
});
await server.listen();
server.printUrls();
