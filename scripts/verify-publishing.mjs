import assert from 'node:assert/strict';
import {
  cp,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// An isolated build proves drafts and future posts cannot leak into any output.
const root = process.cwd();
const temp = await realpath(
  await mkdtemp(path.join(tmpdir(), 'sparsity-publishing-')),
);
const run = (args) =>
  execFileSync(process.execPath, args, {
    cwd: temp,
    encoding: 'utf8',
    stdio: 'pipe',
  });
async function allFiles(dir) {
  return (
    await Promise.all(
      (await readdir(dir, { withFileTypes: true })).map((entry) =>
        entry.isDirectory()
          ? allFiles(path.join(dir, entry.name))
          : path.join(dir, entry.name),
      ),
    )
  ).flat();
}
try {
  for (const file of [
    'src',
    'public',
    'astro.config.mjs',
    'tsconfig.json',
    'package.json',
  ]) {
    await cp(path.join(root, file), path.join(temp, file), { recursive: true });
  }
  await symlink(
    path.join(root, 'node_modules'),
    path.join(temp, 'node_modules'),
    'dir',
  );
  await rm(path.join(temp, 'src/content/notes'), { recursive: true });
  await mkdir(path.join(temp, 'src/content/notes'));
  const fixture = (title, flags = '', date = '2020-01-01') =>
    `---\ntitle: ${JSON.stringify(title)}\ndescription: 'A < B & C'\ndate: ${date}\ncategory: 测试\n${flags}\n---\n\n正文检索词 publication-body-token。\n`;
  await writeFile(
    path.join(temp, 'src/content/notes/public.md'),
    fixture('Published < & title'),
  );
  await writeFile(
    path.join(temp, 'src/content/notes/example.md'),
    fixture('EXAMPLE_MARKER', 'example: true'),
  );
  await writeFile(
    path.join(temp, 'src/content/notes/draft.md'),
    fixture('PRIVATE_DRAFT_MARKER', 'draft: true'),
  );
  await writeFile(
    path.join(temp, 'src/content/notes/future.md'),
    fixture('PRIVATE_FUTURE_MARKER', '', '2099-01-01'),
  );
  run([
    path.join(root, 'node_modules/astro/bin/astro.mjs'),
    'build',
    '--root',
    temp,
  ]);
  const files = await allFiles(path.join(temp, 'dist'));
  const output = (
    await Promise.all(files.map((file) => readFile(file, 'utf8')))
  ).join('\n');
  assert.ok(
    !output.includes('PRIVATE_DRAFT_MARKER'),
    'Draft leaked into build',
  );
  assert.ok(
    !output.includes('PRIVATE_FUTURE_MARKER'),
    'Future post leaked into build',
  );
  assert.ok(
    !files.some((file) => /notes\/(draft|future)\//.test(file)),
    'Private article route generated',
  );
  const rss = await readFile(path.join(temp, 'dist/rss.xml'), 'utf8');
  assert.ok(rss.includes('Published &lt; &amp; title'), 'RSS must escape XML');
  assert.ok(!rss.includes('EXAMPLE_MARKER'), 'Example leaked into RSS');
  const sitemap = await readFile(path.join(temp, 'dist/sitemap.xml'), 'utf8');
  assert.ok(sitemap.includes('/notes/public/'));
  assert.ok(!sitemap.includes('/notes/example/'));
  const article = await readFile(
    path.join(temp, 'dist/notes/public/index.html'),
    'utf8',
  );
  assert.ok(!article.includes('name="robots" content="noindex'));
  assert.ok(article.includes('application/ld+json'));
  const index = JSON.parse(
    await readFile(path.join(temp, 'dist/search-index.json'), 'utf8'),
  );
  assert.equal(index.length, 2);
  assert.ok(
    index.some((entry) => entry.text.includes('publication-body-token')),
  );

  run([path.join(root, 'scripts/new-post.mjs'), 'new-draft', '新文章']);
  const draftPath = path.join(temp, 'src/content/notes/new-draft.md');
  const draft = await readFile(draftPath, 'utf8');
  assert.ok(draft.includes('draft: true'));
  assert.throws(() =>
    run([path.join(root, 'scripts/new-post.mjs'), 'new-draft', '覆盖尝试']),
  );
  assert.equal(await readFile(draftPath, 'utf8'), draft);
  assert.throws(() =>
    run([path.join(root, 'scripts/new-post.mjs'), '../escape', '非法路径']),
  );

  await rm(path.join(temp, 'src/content/notes'), { recursive: true });
  await mkdir(path.join(temp, 'src/content/notes'));
  run([
    path.join(root, 'node_modules/astro/bin/astro.mjs'),
    'build',
    '--root',
    temp,
  ]);
  assert.match(
    await readFile(path.join(temp, 'dist/index.html'), 'utf8'),
    /还没有文章/,
  );
  assert.equal(
    JSON.parse(
      await readFile(path.join(temp, 'dist/search-index.json'), 'utf8'),
    ).length,
    0,
  );
  console.log(
    'Publishing checks passed: drafts, future posts, examples, RSS escaping, article metadata, full-text index, empty blog, and safe draft creation.',
  );
} catch (error) {
  if (error.stdout) console.error(String(error.stdout));
  if (error.stderr) console.error(String(error.stderr));
  throw error;
} finally {
  await rm(temp, { recursive: true, force: true });
}
