import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = path.resolve('dist');
const origin = 'https://sparsity.tech';
async function walk(dir) {
  return (
    await Promise.all(
      (await readdir(dir, { withFileTypes: true })).map((entry) =>
        entry.isDirectory()
          ? walk(path.join(dir, entry.name))
          : path.join(dir, entry.name),
      ),
    )
  ).flat();
}
async function targetFile(url) {
  const target = path.join(root, decodeURIComponent(url.pathname));
  return (await stat(target)).isDirectory()
    ? path.join(target, 'index.html')
    : target;
}
const files = await walk(root);
const htmlFiles = files.filter((file) => file.endsWith('.html'));
const errors = [];
let links = 0;
let redirects = 0;
for (const file of htmlFiles) {
  const html = await readFile(file, 'utf8');
  const relative = path.relative(root, file).split(path.sep).join('/');
  const route = `/${relative.replace(/index\.html$/, '')}`;
  const redirect = /http-equiv="refresh"/.test(html);
  if (redirect) redirects++;
  else {
    if (!/<html[^>]*lang="zh-CN"/.test(html))
      errors.push(`${relative}: missing language`);
    if (!/<title>[^<]+<\/title>/.test(html))
      errors.push(`${relative}: missing title`);
    if ((html.match(/<h1[ >]/g) ?? []).length !== 1)
      errors.push(`${relative}: expected one h1`);
    if (!html.includes(`rel="canonical" href="${new URL(route, origin).href}"`))
      errors.push(`${relative}: wrong canonical`);
    if (/href="\/(a|b|c|compare)\//.test(html))
      errors.push(`${relative}: still links to a style preview`);
    if (!html.includes('type="application/rss+xml"'))
      errors.push(`${relative}: missing RSS discovery`);
    if (html.split('</html>')[1]?.trim())
      errors.push(`${relative}: content outside the document`);
    if (/<pre[^>]*class="astro-code(?! github-light)/.test(html))
      errors.push(`${relative}: code theme does not match the light page`);
  }
  for (const [, rawUrl] of html.matchAll(/\b(?:href|src)="([^"]+)"/g)) {
    const url = new URL(
      rawUrl.replaceAll('&amp;', '&'),
      new URL(route, origin),
    );
    if (url.origin !== origin) continue;
    try {
      const target = await targetFile(url);
      await stat(target);
      if (url.hash && target.endsWith('.html')) {
        const targetHtml = await readFile(target, 'utf8');
        assert.ok(
          targetHtml.includes(`id="${decodeURIComponent(url.hash.slice(1))}"`),
          'Missing anchor',
        );
      }
      links++;
    } catch {
      errors.push(`${relative}: broken reference ${rawUrl}`);
    }
  }
}
for (const file of [
  'index.html',
  'archive/index.html',
  'about/index.html',
  '404.html',
  'rss.xml',
  'sitemap.xml',
  'robots.txt',
  'search-index.json',
]) {
  assert.ok(files.includes(path.join(root, file)), `Missing ${file}`);
}
const index = JSON.parse(
  await readFile(path.join(root, 'search-index.json'), 'utf8'),
);
const rss = await readFile(path.join(root, 'rss.xml'), 'utf8');
const sitemap = await readFile(path.join(root, 'sitemap.xml'), 'utf8');
for (const entry of index) {
  const article = await readFile(
    await targetFile(new URL(entry.url, origin)),
    'utf8',
  );
  assert.ok(
    article.includes('class="article-content"'),
    `Missing article ${entry.url}`,
  );
  assert.ok(entry.title && entry.text && entry.date, 'Incomplete search entry');
  const url = new URL(entry.url, origin).href;
  if (entry.example) {
    assert.match(article, /name="robots" content="noindex/);
    assert.ok(!rss.includes(url), 'Example included in RSS');
    assert.ok(!sitemap.includes(url), 'Example included in sitemap');
  } else {
    assert.ok(rss.includes(url), 'Published article missing from RSS');
    assert.ok(sitemap.includes(url), 'Published article missing from sitemap');
  }
}
for (const [, location] of sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)) {
  const html = await readFile(await targetFile(new URL(location)), 'utf8');
  assert.ok(
    !/name="robots" content="noindex/.test(html),
    `Sitemap includes noindex: ${location}`,
  );
}
assert.match(
  await readFile(path.join(root, 'robots.txt'), 'utf8'),
  /Sitemap: https:\/\/sparsity\.tech\/sitemap\.xml/,
);
assert.equal(errors.length, 0, errors.join('\n'));
console.log(
  `Verified ${htmlFiles.length - redirects} pages, ${redirects} redirects, ${links} internal references, RSS, sitemap and search index.`,
);
