// Vercel 部署用建置（Build Output API v3）：
// 1. 建置前端到 dist/
// 2. 把後端打包成單一檔案，放成一個 Vercel 函式（處理 /api/*）
// 3. 產生 .vercel/output（靜態網頁 + 函式 + 路由），Vercel 會直接使用
import { build } from 'esbuild';
import { execSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = `${root}.vercel/output`;
const fn = `${out}/functions/api.func`;

execSync('npx vite build', { cwd: root, stdio: 'inherit' });

rmSync(out, { recursive: true, force: true });
mkdirSync(fn, { recursive: true });
cpSync(`${root}dist`, `${out}/static`, { recursive: true });

await build({
  entryPoints: [`${root}server/vercel.ts`],
  outfile: `${fn}/index.mjs`,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  // pg-native 為選用套件；PGlite 只在本機使用
  external: ['pg-native', '@electric-sql/pglite'],
  // 打包後的 ESM 中仍有 CommonJS 套件需要 require
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: 'info',
});

writeFileSync(
  `${fn}/.vc-config.json`,
  JSON.stringify({ runtime: 'nodejs22.x', handler: 'index.mjs', launcherType: 'Nodejs', shouldAddHelpers: false, maxDuration: 60 }, null, 2),
);

writeFileSync(
  `${out}/config.json`,
  JSON.stringify(
    {
      version: 3,
      routes: [
        { src: '^/api(?:/.*)?$', dest: '/api' },
        { handle: 'filesystem' },
        // 單頁應用：其他路徑都回傳 index.html，交給前端路由
        { src: '/.*', dest: '/index.html' },
      ],
    },
    null,
    2,
  ),
);
console.log('✅ Vercel 輸出已建立：.vercel/output');
