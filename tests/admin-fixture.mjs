import { cp, mkdtemp, realpath, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startAdmin } from '../admin/server.mjs';

export const root = fileURLToPath(new URL('../', import.meta.url));
export async function fixture(options = {}) {
  const dir = await realpath(
    await mkdtemp(path.join(tmpdir(), 'sparsity-admin-test-')),
  );
  for (const file of [
    'src',
    'public',
    'scripts',
    'astro.config.mjs',
    'tsconfig.json',
    'package.json',
  ])
    await cp(path.join(root, file), path.join(dir, file), { recursive: true });
  await symlink(
    path.join(root, 'node_modules'),
    path.join(dir, 'node_modules'),
    'dir',
  );
  const app = await startAdmin({ root: dir, port: 0, ...options });
  return {
    dir,
    app,
    async close() {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

export const examplePost = (overrides = {}) => ({
  slug: 'admin-check',
  title: '后台验证文章',
  description: 'A < B & C',
  category: '测试',
  date: '2020-01-01',
  draft: true,
  example: false,
  body: '## 正文\n\nadmin-private-marker\n\n```js\nconst answer = 42;\n```\n',
  ...overrides,
});
export const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/qcAAAAASUVORK5CYII=',
  'base64',
);
