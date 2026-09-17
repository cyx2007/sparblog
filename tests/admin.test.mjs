import test from 'node:test';
import assert from 'node:assert/strict';
import {
  readFile,
  writeFile,
  readdir,
  readlink,
  symlink,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';
import { request as httpRequest } from 'node:http';
import { fixture, examplePost, png } from './admin-fixture.mjs';
import { startAdmin } from '../admin/server.mjs';

function rawRequest(url, options = {}, body) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, options, (res) => {
      res.resume();
      res.on('end', () => resolve(res));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('administration: authentication, content, media, preview and atomic publication', async (t) => {
  const ctx = await fixture();
  t.after(() => ctx.close());
  const { app, dir } = ctx;
  let cookie = '';
  let csrf = '';
  async function request(
    route,
    {
      method = 'GET',
      data,
      status = 200,
      headers = {},
      authenticated = true,
      raw = false,
    } = {},
  ) {
    const response = await fetch(`${app.origin}/admin/api/${route}`, {
      method,
      headers: {
        ...(authenticated ? { Cookie: cookie, 'X-CSRF-Token': csrf } : {}),
        ...(method !== 'GET'
          ? {
              Origin: app.origin,
              'Content-Type': raw
                ? 'application/octet-stream'
                : 'application/json',
            }
          : {}),
        ...headers,
      },
      body: data === undefined ? undefined : raw ? data : JSON.stringify(data),
    });
    const value = await response.json();
    assert.equal(
      response.status,
      status,
      `${method} ${route}: ${JSON.stringify(value)}`,
    );
    return { value, response };
  }
  await t.test(
    'private endpoints, bootstrap token, origin and session cookies',
    async () => {
      for (const route of [
        'posts',
        'media',
        'trash',
        'settings',
        'publication',
      ])
        await request(route, { status: 401, authenticated: false });
      const session = await request('session', { authenticated: false });
      assert.equal(session.value.needsSetup, true);
      await assert.rejects(startAdmin({ root: dir, port: 0 }), /已在运行/);
      assert.ok(!JSON.stringify(session.value).includes(app.bootstrap));
      await request('setup', {
        method: 'POST',
        data: {
          username: 'admin',
          password: 'a-long-test-password',
          token: 'invalid',
        },
        status: 403,
      });
      await request('setup', {
        method: 'POST',
        data: {},
        headers: { Origin: 'https://untrusted.invalid' },
        status: 403,
      });
      const { value, response } = await request('setup', {
        method: 'POST',
        data: {
          username: 'admin',
          password: 'a-long-test-password',
          token: app.bootstrap,
        },
      });
      csrf = value.csrf;
      cookie = response.headers.get('set-cookie').split(';')[0];
      assert.match(
        response.headers.get('set-cookie'),
        /HttpOnly; SameSite=Strict/,
      );
      assert.match(response.headers.get('cache-control'), /no-store/);
      assert.match(response.headers.get('x-robots-tag'), /noindex/);
      const account = await readFile(
        path.join(dir, '.admin/account.json'),
        'utf8',
      );
      assert.ok(!account.includes('a-long-test-password'));
      await request('setup', { method: 'POST', data: {}, status: 409 });
      await request('login', {
        method: 'POST',
        data: { username: 'admin', password: 'incorrect' },
        status: 401,
      });
      await request('posts', {
        method: 'POST',
        data: examplePost(),
        headers: { 'X-CSRF-Token': 'bad' },
        status: 403,
      });
      const html = await fetch(`${app.origin}/admin/`);
      assert.match(await html.text(), /登录后台/);
      const badHost = await rawRequest(`${app.origin}/admin/api/session`, {
        headers: { Host: 'evil.invalid' },
      });
      assert.equal(badHost.statusCode, 403);
    },
  );
  let post;
  let media;
  let settings;
  await t.test(
    'website settings persist, validate and reject stale or unauthorized writes',
    async () => {
      const initial = (await request('settings')).value;
      assert.equal(initial.description, '计算机、数学，与一些随想。');
      assert.match(initial.about, /\[归档\]\(\/archive\/\)/);
      await request('settings', {
        method: 'PUT',
        data: initial,
        authenticated: false,
        status: 401,
      });
      await request('settings', {
        method: 'PUT',
        data: initial,
        headers: { 'X-CSRF-Token': 'bad' },
        status: 403,
      });
      for (const invalid of [
        { ...initial, description: '   ' },
        { ...initial, description: 'x'.repeat(241) },
        { ...initial, about: 'x'.repeat(100_001) },
        { ...initial, about: null },
        { ...initial, url: 'https://untrusted.invalid' },
      ])
        await request('settings', {
          method: 'PUT',
          data: invalid,
          status: 400,
        });
      settings = (
        await request('settings', {
          method: 'PUT',
          data: {
            ...initial,
            description: '自定义介绍 A < B & C "札记"',
            about:
              '## 关于本站\n\n自定义 **关于正文**。\n\n[所有文章](/archive/)\n',
          },
        })
      ).value;
      assert.notEqual(settings.revision, initial.revision);
      await request('settings', { method: 'PUT', data: initial, status: 409 });
      assert.deepEqual((await request('settings')).value, settings);
      const saved = JSON.parse(
        await readFile(path.join(dir, 'src/data/settings/site.json'), 'utf8'),
      );
      assert.deepEqual(saved, {
        description: settings.description,
        about: settings.about,
      });
      assert.equal((await request('publication')).value.pending, true);
    },
  );
  await t.test(
    'real Markdown persistence, validation and optimistic concurrency',
    async () => {
      assert.equal((await request('posts')).value.length, 6);
      for (const bad of [
        examplePost({ slug: '../escape' }),
        examplePost({ category: '..' }),
        examplePost({ date: '2026-02-30' }),
        examplePost({ updated: '2019-01-01' }),
        examplePost({ draft: 'false' }),
      ])
        await request('posts', { method: 'POST', data: bad, status: 400 });
      post = (
        await request('posts', {
          method: 'POST',
          data: examplePost(),
          status: 201,
        })
      ).value;
      assert.equal(post.draft, true);
      assert.match(
        await readFile(
          path.join(dir, 'src/content/notes/admin-check.md'),
          'utf8',
        ),
        /admin-private-marker/,
      );
      await request('posts', {
        method: 'POST',
        data: examplePost(),
        status: 409,
      });
      const previous = post;
      post = (
        await request('posts/admin-check', {
          method: 'PUT',
          data: { ...post, title: '修改后的标题' },
        })
      ).value;
      await request('posts/admin-check', {
        method: 'PUT',
        data: previous,
        status: 409,
      });
      const postPath = path.join(dir, 'src/content/notes/admin-check.md');
      const source = await readFile(postPath, 'utf8');
      await writeFile(
        postPath,
        source.replace(
          '---\n',
          '---\n# Keep this comment\ncustomField: keep-me\n',
        ),
      );
      post = (await request('posts/admin-check')).value;
      post = (
        await request('posts/admin-check', {
          method: 'PUT',
          data: { ...post, description: '更新摘要' },
        })
      ).value;
      const updated = await readFile(postPath, 'utf8');
      assert.match(updated, /# Keep this comment/);
      assert.match(updated, /customField: keep-me/);
      const link = path.join(dir, 'src/content/notes/unsafe.md');
      await symlink(path.join(dir, '.admin/account.json'), link);
      await request('posts/unsafe', { status: 400 });
      await unlink(link);
    },
  );
  await t.test(
    'preview is authenticated, sandboxed and uses the Markdown renderer',
    async () => {
      const result = (
        await request('preview', {
          method: 'POST',
          data: {
            title: '<script>title</script>',
            body: '## 预览\n\n**内容**\n\n```js\nconst answer = 42;\n```\n<script>parent.document.body.remove()</script>',
          },
        })
      ).value;
      assert.match(result.html, /<strong>内容<\/strong>/);
      assert.match(result.html, /astro-code/);
      assert.match(result.html, /default-src 'none'/);
      assert.match(result.html, /&lt;script&gt;title/);
      const page = await (await fetch(`${app.origin}/admin/`)).text();
      assert.match(page, /sandbox="allow-same-origin"/);
      assert.ok(!page.includes('allow-scripts'));
      await request('preview', {
        method: 'POST',
        data: { body: 'x'.repeat(600_000) },
        status: 413,
      });
    },
  );
  await t.test(
    'image types, private access and references are enforced',
    async () => {
      await request('media', {
        method: 'POST',
        data: Buffer.from('<svg onload="alert(1)"></svg>'),
        raw: true,
        status: 400,
      });
      media = (
        await request('media', {
          method: 'POST',
          data: png,
          raw: true,
          status: 201,
        })
      ).value;
      const privateImage = await fetch(`${app.origin}/admin${media.url}`);
      assert.equal(privateImage.status, 401);
      const image = await fetch(`${app.origin}/admin${media.url}`, {
        headers: { Cookie: cookie },
      });
      assert.equal(image.headers.get('content-type'), 'image/png');
      assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);
      const originalAbout = settings.about;
      settings = (
        await request('settings', {
          method: 'PUT',
          data: {
            ...settings,
            about: `${settings.about}\n![关于配图](${media.url})`,
          },
        })
      ).value;
      await request('media', {
        method: 'DELETE',
        data: { name: media.name },
        status: 409,
      });
      settings = (
        await request('settings', {
          method: 'PUT',
          data: { ...settings, about: originalAbout },
        })
      ).value;
      post = (
        await request('posts/admin-check', {
          method: 'PUT',
          data: { ...post, body: `${post.body}\n![test](${media.url})` },
        })
      ).value;
      await request('media', {
        method: 'DELETE',
        data: { name: media.name },
        status: 409,
      });
      await request('media', {
        method: 'DELETE',
        data: { name: '../../.admin/account.json' },
        status: 400,
      });
    },
  );
  await t.test(
    'trash, no-overwrite restore and reference protection for archived posts',
    async () => {
      await request('posts/admin-check', {
        method: 'DELETE',
        data: { revision: 'old' },
        status: 409,
      });
      await request('posts/admin-check', {
        method: 'DELETE',
        data: { revision: post.revision },
      });
      await request('posts/admin-check', { status: 404 });
      const trash = (await request('trash')).value;
      assert.equal(trash.length, 1);
      await request('media', {
        method: 'DELETE',
        data: { name: media.name },
        status: 409,
      });
      await request('posts', {
        method: 'POST',
        data: examplePost(),
        status: 201,
      });
      await request('restore', {
        method: 'POST',
        data: { id: trash[0].id },
        status: 409,
      });
      await unlink(path.join(dir, 'src/content/notes/admin-check.md'));
      const restored = (
        await request('restore', { method: 'POST', data: { id: trash[0].id } })
      ).value;
      assert.equal(restored.revision, post.revision);
      assert.equal((await request('trash')).value.length, 0);
    },
  );
  await t.test(
    'successful isolated build excludes drafts/future posts and all private administration files',
    async () => {
      await request('posts', {
        method: 'POST',
        data: examplePost({
          slug: 'public-check',
          title: 'PUBLIC_CHECK',
          body: 'Public body',
          draft: false,
        }),
        status: 201,
      });
      await request('posts', {
        method: 'POST',
        data: examplePost({
          slug: 'future-check',
          title: 'PRIVATE_FUTURE_ADMIN',
          date: '2099-01-01',
          draft: false,
        }),
        status: 201,
      });
      await request('publish', { method: 'POST', data: {}, status: 202 });
      await request('publish', { method: 'POST', data: {}, status: 409 });
      await request('posts/admin-check', {
        method: 'PUT',
        data: post,
        status: 409,
      });
      await request('settings', { method: 'PUT', data: settings, status: 409 });
      await app.publisher.idle();
      const publication = (await request('publication')).value;
      assert.equal(
        publication.history[0].status,
        'succeeded',
        publication.history[0].log,
      );
      assert.equal(publication.pending, false);
      assert.ok(publication.manifest['public-check']);
      assert.ok(!publication.manifest['admin-check']);
      assert.ok(!publication.manifest['future-check']);
      const active = await app.publisher.current();
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
      const files = await allFiles(active);
      assert.ok(
        !files.some((file) => /(?:account\.json|admin\/|\.md$)/.test(file)),
      );
      const text = (
        await Promise.all(
          files
            .filter((file) => /\.(?:html|xml|json)$/.test(file))
            .map((file) => readFile(file, 'utf8')),
        )
      ).join('\n');
      assert.ok(!text.includes('admin-private-marker'));
      assert.ok(!text.includes('PRIVATE_FUTURE_ADMIN'));
      assert.ok(!text.includes(app.bootstrap));
      const about = await (await fetch(`${app.origin}/about/`)).text();
      assert.match(about, /<strong>关于正文<\/strong>/);
      assert.ok(!about.includes('用于展示排版，不计入 RSS 订阅'));
      assert.ok(about.includes(`©${new Date().getFullYear()} 稀疏札记`));
      const home = await (await fetch(app.origin)).text();
      assert.match(home, /自定义介绍 A &lt; B &amp; C/);
      assert.equal(
        (await fetch(`${app.origin}/notes/public-check/`)).status,
        200,
      );
      assert.equal(
        (await fetch(`${app.origin}/notes/admin-check/`)).status,
        404,
      );
      assert.equal(
        (await fetch(`${app.origin}/.admin/account.json`)).status,
        400,
      );
      assert.ok(
        Array.isArray(
          await (await fetch(`${app.origin}/search-index.json`)).json(),
        ),
      );
      const feed = await (await fetch(`${app.origin}/rss.xml`)).text();
      assert.match(feed, /PUBLIC_CHECK/);
      assert.match(feed, /自定义介绍 A &lt; B &amp; C/);
      assert.ok(!feed.includes('Hello, world'));
      assert.equal(
        (
          await fetch(`${app.origin}/a/archive/`, { redirect: 'manual' })
        ).headers.get('location'),
        '/archive/',
      );
    },
  );
  await t.test(
    'public layout, styles, configuration and assets are pending until published',
    async () => {
      for (const relative of [
        'src/layouts/SiteLayout.astro',
        'src/styles/global.css',
        'src/data/site.ts',
        'src/data/settings/site.json',
        'public/favicon.svg',
        'astro.config.mjs',
        'tsconfig.json',
        'package.json',
      ]) {
        const file = path.join(dir, relative);
        const original = await readFile(file, 'utf8');
        try {
          await writeFile(file, `${original}\n`);
          assert.equal(
            (await request('publication')).value.pending,
            true,
            relative,
          );
        } finally {
          await writeFile(file, original);
        }
        assert.equal(
          (await request('publication')).value.pending,
          false,
          relative,
        );
      }
      const layout = path.join(dir, 'src/layouts/SiteLayout.astro');
      const original = await readFile(layout, 'utf8');
      settings = (
        await request('settings', {
          method: 'PUT',
          data: {
            ...settings,
            description: '第二版网站介绍',
            about: '## 第二版关于\n\n保存后重新发布。',
          },
        })
      ).value;
      assert.equal((await request('publication')).value.pending, true);
      assert.ok(
        !(await (await fetch(app.origin)).text()).includes(
          settings.description,
        ),
      );
      assert.ok(
        !(await (await fetch(`${app.origin}/about/`)).text()).includes(
          '第二版关于',
        ),
      );
      await writeFile(
        layout,
        original.replace(
          '</footer>',
          '<span>PUBLIC_FOOTER_UPDATE</span></footer>',
        ),
      );
      assert.ok(
        !(await (await fetch(app.origin)).text()).includes(
          'PUBLIC_FOOTER_UPDATE',
        ),
      );
      await request('publish', { method: 'POST', data: {}, status: 202 });
      await app.publisher.idle();
      const publication = (await request('publication')).value;
      assert.equal(
        publication.history[0].status,
        'succeeded',
        publication.history[0].log,
      );
      assert.equal(publication.pending, false);
      assert.match(
        await (await fetch(app.origin)).text(),
        /PUBLIC_FOOTER_UPDATE/,
      );
      assert.match(await (await fetch(app.origin)).text(), /第二版网站介绍/);
      assert.match(
        await (await fetch(`${app.origin}/about/`)).text(),
        /第二版关于/,
      );
    },
  );
  await t.test(
    'failed build preserves the previous complete public release',
    async () => {
      const previous = await readlink(path.join(dir, 'published/current'));
      await request('posts', {
        method: 'POST',
        data: examplePost({
          slug: 'bad-link',
          draft: false,
          body: '[broken](/missing-publishing-check/)',
        }),
        status: 201,
      });
      await request('publish', { method: 'POST', data: {}, status: 202 });
      await app.publisher.idle();
      const publication = (await request('publication')).value;
      assert.equal(publication.history[0].status, 'failed');
      assert.match(publication.history[0].log, /broken reference/);
      assert.equal(
        await readlink(path.join(dir, 'published/current')),
        previous,
      );
      assert.equal(publication.pending, true);
      assert.equal(
        (await fetch(`${app.origin}/notes/public-check/`)).status,
        200,
      );
    },
  );
  await t.test(
    'password rotation invalidates older sessions, logout invalidates current session',
    async () => {
      const oldCookie = cookie;
      const changed = await request('password', {
        method: 'POST',
        data: {
          currentPassword: 'a-long-test-password',
          password: 'another-long-test-password',
        },
      });
      cookie = changed.response.headers.get('set-cookie').split(';')[0];
      csrf = changed.value.csrf;
      await request('posts', { headers: { Cookie: oldCookie }, status: 401 });
      await request('logout', { method: 'POST', data: {} });
      await request('posts', { status: 401 });
    },
  );
});

test('remote origin requires HTTPS, and HTTPS sessions use Secure cookies', async (t) => {
  await assert.rejects(
    startAdmin({ origin: 'http://example.com', port: 0 }),
    /HTTPS/,
  );
  const ctx = await fixture({ origin: 'https://blog.example' });
  t.after(() => ctx.close());
  const response = await rawRequest(
    `http://127.0.0.1:${ctx.app.server.address().port}/admin/api/setup`,
    {
      method: 'POST',
      headers: {
        Host: 'blog.example',
        Origin: 'https://blog.example',
        'Content-Type': 'application/json',
      },
    },
    JSON.stringify({
      token: ctx.app.bootstrap,
      username: 'admin',
      password: 'another-long-test-password',
    }),
  );
  assert.equal(response.statusCode, 200);
  assert.match(response.headers['set-cookie'][0], /; Secure/);
});
