import { createServer } from 'node:http';
import { Buffer } from 'node:buffer';
import { mkdir, readFile, stat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { satteri } from '@astrojs/markdown-satteri';
import { createAuth, fail } from './auth.mjs';
import {
  createStore,
  safePath,
  imageType,
  MAX_IMAGE,
  MAX_BODY,
} from './store.mjs';
import { createPublisher } from './publish.mjs';
import { claimLock } from './lock.mjs';

const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const escapeHtml = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        char
      ],
  );
const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

export async function startAdmin(options = {}) {
  const root = await realpath(options.root || sourceRoot);
  const stateDir = path.resolve(
    root,
    options.stateDir || process.env.ADMIN_STATE_DIR || '.admin',
  );
  const publishDir = path.resolve(
    root,
    options.publishDir || process.env.ADMIN_PUBLISH_DIR || 'published',
  );
  const within = (parent, child) =>
    child === parent || child.startsWith(`${parent}${path.sep}`);
  if (
    within(publishDir, stateDir) ||
    within(stateDir, publishDir) ||
    within(path.join(root, 'public'), stateDir) ||
    within(path.join(root, 'public'), publishDir) ||
    within(path.join(root, 'dist'), stateDir)
  )
    throw new Error('私有状态、公开版本和 public/dist 目录必须彼此隔离。');
  const host = options.host || process.env.ADMIN_HOST || '127.0.0.1';
  const port = options.port ?? Number(process.env.ADMIN_PORT || 4330);
  let origin = options.origin || process.env.ADMIN_ORIGIN;
  if (host !== '127.0.0.1' && host !== '::1' && !origin)
    throw new Error('公开监听需要显式配置 HTTPS 的 ADMIN_ORIGIN。');
  if (origin) {
    const configured = new URL(origin);
    if (
      configured.origin !== origin ||
      (configured.protocol !== 'https:' &&
        !['127.0.0.1', 'localhost', '[::1]'].includes(configured.hostname))
    )
      throw new Error(
        'ADMIN_ORIGIN 需要是无路径的 HTTPS 域名；本机可使用 HTTP。',
      );
  }
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const auth = await createAuth(stateDir, origin?.startsWith('https:'));
  const store = await createStore(root, stateDir);
  const publisher = await createPublisher(root, stateDir, publishDir, store);
  const releaseLock = await claimLock(stateDir);
  let renderer;
  let queue = Promise.resolve();
  function mutate(action) {
    const work = queue.then(() => {
      if (publisher.busy) fail(409, '正在构建，请等待完成后再修改内容。');
      return action();
    });
    queue = work.catch(() => {});
    return work;
  }
  async function body(req, max = MAX_BODY + 32 * 1024, binary = false) {
    if (Number(req.headers['content-length']) > max)
      fail(413, '请求内容过大。');
    if (
      !binary &&
      !/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')
    )
      fail(415, '请求需要使用 JSON。');
    const chunks = [];
    let length = 0;
    for await (const chunk of req) {
      length += chunk.length;
      if (length > max) fail(413, '请求内容过大。');
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);
    if (binary) return buffer;
    try {
      const data = JSON.parse(buffer.toString());
      if (!data || typeof data !== 'object' || Array.isArray(data))
        fail(400, '请求数据无效。');
      return data;
    } catch {
      fail(400, '请求数据不是有效的 JSON 对象。');
    }
  }
  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    function send(
      data,
      status = 200,
      type = 'application/json; charset=utf-8',
    ) {
      res.writeHead(status, { 'Content-Type': type });
      res.end(
        req.method === 'HEAD'
          ? undefined
          : Buffer.isBuffer(data)
            ? data
            : type.startsWith('application/json')
              ? JSON.stringify(data)
              : data,
      );
    }
    async function file(filePath, status = 200) {
      send(
        await readFile(filePath),
        status,
        types[path.extname(filePath)] || 'application/octet-stream',
      );
    }
    try {
      if (req.headers.host !== new URL(origin).host)
        fail(403, '请求域名与后台配置不匹配。');
      const url = new URL(req.url, origin);
      const route = decodeURIComponent(url.pathname);
      const method = req.method;
      const admin = route === '/admin' || route.startsWith('/admin/');
      if (!admin) {
        if (!['GET', 'HEAD'].includes(method)) fail(405, '不支持此请求方式。');
        const active = await publisher.current();
        if (!active)
          return send(
            '还没有发布版本。请打开 /admin/ 登录后台并构建发布。',
            503,
            'text/plain; charset=utf-8',
          );
        const old = route.match(/^\/(?:[abc]|compare)(?:\/(.*))?$/);
        if (old) {
          res.writeHead(301, { Location: old[1] ? `/${old[1]}` : '/' });
          return res.end();
        }
        try {
          let target = await safePath(
            active,
            route === '/' ? 'index.html' : route.slice(1).replace(/\/$/, ''),
          );
          if ((await stat(target)).isDirectory()) {
            if (!route.endsWith('/')) {
              res.writeHead(301, { Location: `${url.pathname}/${url.search}` });
              return res.end();
            }
            target = path.join(target, 'index.html');
          }
          res.setHeader(
            'Cache-Control',
            route.startsWith('/_astro/')
              ? 'public, max-age=31536000, immutable'
              : 'no-cache',
          );
          return await file(target);
        } catch (error) {
          if (error.status === 404 || error.code === 'ENOENT')
            return await file(path.join(active, '404.html'), 404);
          throw error;
        }
      }
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Robots-Tag', 'noindex, nofollow');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src 'self' about:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      );
      if (req.headers['sec-fetch-site'] === 'cross-site')
        fail(403, '不接受跨站请求。');
      if (!['GET', 'HEAD'].includes(method) && req.headers.origin !== origin)
        fail(403, '请求来源校验失败。');
      if (route === '/admin') {
        res.writeHead(302, { Location: '/admin/' });
        return res.end();
      }
      if (['GET', 'HEAD'].includes(method)) {
        if (route === '/admin/')
          return await file(path.join(sourceRoot, 'admin/web/index.html'));
        if (route === '/admin/app.js')
          return await file(path.join(sourceRoot, 'admin/web/app.js'));
        if (route === '/admin/vendor/easymde.js')
          return await file(
            path.join(sourceRoot, 'node_modules/easymde/dist/easymde.min.js'),
          );
        if (route === '/admin/style.css') {
          // Third-party editor styles are served only to the administration UI.
          const styles = await Promise.all([
            readFile(
              path.join(
                sourceRoot,
                'node_modules/easymde/dist/easymde.min.css',
              ),
              'utf8',
            ),
            readFile(path.join(root, 'src/styles/global.css'), 'utf8'),
          ]);
          return send(styles.join('\n'), 200, 'text/css; charset=utf-8');
        }
        if (route === '/admin/favicon.svg')
          return await file(path.join(root, 'public/favicon.svg'));
      }
      if (route === '/admin/api/session' && method === 'GET') {
        const session = auth.session(req);
        return send({
          authenticated: Boolean(session),
          needsSetup: !auth.configured,
          username: session ? auth.username : undefined,
          csrf: session?.csrf,
        });
      }
      if (
        ['/admin/api/login', '/admin/api/setup'].includes(route) &&
        method === 'POST'
      ) {
        const data = await body(req, 4096);
        const result = await (route.endsWith('setup')
          ? mutate(() => auth.setup(req, data))
          : auth.login(req, data));
        res.setHeader('Set-Cookie', result.cookie);
        return send({ username: result.username, csrf: result.csrf });
      }
      auth.require(req, !['GET', 'HEAD'].includes(method));
      if (route === '/admin/api/logout' && method === 'POST') {
        res.setHeader('Set-Cookie', auth.logout(req));
        return send({ ok: true });
      }
      if (route === '/admin/api/password' && method === 'POST') {
        const result = await auth.changePassword(req, await body(req, 4096));
        res.setHeader('Set-Cookie', result.cookie);
        return send({ username: result.username, csrf: result.csrf });
      }
      if (route === '/admin/api/settings' && method === 'GET')
        return send(await store.settings());
      if (route === '/admin/api/settings' && method === 'PUT') {
        const data = await body(req);
        return send(await mutate(() => store.saveSettings(data)));
      }
      if (route === '/admin/api/posts' && method === 'GET')
        return send(await store.list());
      if (route === '/admin/api/posts' && method === 'POST') {
        const data = await body(req);
        return send(await mutate(() => store.save(data.slug, data, true)), 201);
      }
      if (route.startsWith('/admin/api/posts/')) {
        const slug = route.slice('/admin/api/posts/'.length);
        if (method === 'GET') return send(await store.get(slug));
        if (method === 'PUT') {
          const data = await body(req);
          return send(await mutate(() => store.save(slug, data, false)));
        }
        if (method === 'DELETE') {
          const data = await body(req, 4096);
          await mutate(() => store.remove(slug, data.revision));
          return send({ ok: true });
        }
      }
      if (route === '/admin/api/trash' && method === 'GET')
        return send(await store.trash());
      if (route === '/admin/api/restore' && method === 'POST') {
        const data = await body(req, 4096);
        return send(await mutate(() => store.restore(data.id)));
      }
      if (route === '/admin/api/media' && method === 'GET')
        return send(await store.media());
      if (route === '/admin/api/media' && method === 'POST') {
        const data = await body(req, MAX_IMAGE, true);
        return send(await mutate(() => store.upload(data)), 201);
      }
      if (route === '/admin/api/media' && method === 'DELETE') {
        const data = await body(req, 4096);
        await mutate(() => store.removeMedia(data.name));
        return send({ ok: true });
      }
      if (
        route.startsWith('/admin/images/') &&
        ['GET', 'HEAD'].includes(method)
      ) {
        const data = await readFile(
          await safePath(store.mediaDir, route.slice('/admin/images/'.length)),
        );
        return send(data, 200, imageType(data).mime);
      }
      if (route === '/admin/api/preview' && method === 'POST') {
        const data = await body(req);
        if (
          typeof data.body !== 'string' ||
          Buffer.byteLength(data.body) > MAX_BODY
        )
          fail(400, '正文最多为 512 KB。');
        renderer ||= satteri().createRenderer({
          shikiConfig: { theme: 'github-light' },
        });
        const rendered = await (await renderer).render(data.body);
        const html = rendered.code.replace(
          /(src=")\/images\//g,
          '$1/admin/images/',
        );
        return send({
          html: `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'none'"><link rel="stylesheet" href="/admin/style.css"></head><body class="admin-preview"><article class="article-content"><header class="article-header"><h1>${escapeHtml(data.title || '未命名文章')}</h1></header><div class="prose">${html}</div></article></body></html>`,
        });
      }
      if (route === '/admin/api/publication' && method === 'GET')
        return send(await publisher.info());
      if (route === '/admin/api/publish' && method === 'POST')
        return send(await mutate(() => publisher.start()), 202);
      fail(404, '没有找到这个后台接口。');
    } catch (error) {
      const status = error.status || (error.code === 'ENOENT' ? 404 : 500);
      if (status === 500) console.error(error);
      if (!res.headersSent)
        send(
          {
            error:
              status === 500
                ? '操作失败，请检查后台日志后重试。'
                : error.message,
          },
          status,
        );
      else res.end();
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  }).catch(async (error) => {
    await releaseLock();
    throw error;
  });
  origin ||= `http://${host === '::1' ? '[::1]' : host}:${server.address().port}`;
  return {
    server,
    origin,
    bootstrap: auth.bootstrap,
    publisher,
    async close() {
      await publisher.idle();
      server.closeIdleConnections();
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await releaseLock();
    },
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const app = await startAdmin();
  console.log(`后台：${app.origin}/admin/`);
  if (app.bootstrap)
    console.log(
      `首次创建管理员，请使用此私密链接：\n${app.origin}/admin/#setup=${app.bootstrap}`,
    );
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.once(signal, () => {
      app.close().then(() => process.exit(0));
    });
}
