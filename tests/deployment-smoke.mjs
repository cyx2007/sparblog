import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import {
  bundleFiles,
  parseRelease,
  sha256,
} from '../scripts/release-utils.mjs';

assert.equal(
  process.platform,
  'linux',
  'Run the deployment smoke test on a native Linux host.',
);
assert.ok(
  process.env.RELEASE_BUNDLE,
  'Set RELEASE_BUNDLE to an extracted release directory.',
);
const bundle = path.resolve(process.env.RELEASE_BUNDLE);
const source = parseRelease(
  await readFile(path.join(bundle, 'release.env'), 'utf8'),
);
const temp = await mkdtemp(path.join(tmpdir(), 'sparblog-deploy-test-'));
const root = path.join(temp, 'installed');
const project = `sparblog-test-${randomUUID().slice(0, 8)}`;
const upgradedVersion = `v0.0.0-upgrade.${project.slice(-8)}`;
const brokenVersion = `v0.0.0-broken.${project.slice(-8)}`;
const testImages = [];
const run = (cmd, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output = (output + chunk).slice(-200_000);
    });
    child.stderr.on('data', (chunk) => {
      output = (output + chunk).slice(-200_000);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code && !options.fail)
        reject(new Error(`${cmd} ${args.join(' ')} exited ${code}\n${output}`));
      else resolve({ code, output });
    });
  });
const docker = async (...args) => (await run('docker', args)).output.trim();
const manage = (...args) =>
  run('bash', [path.join(root, 'manage.sh'), ...args]);
const port = async () => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const value = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return value;
};
const origin = `http://localhost:${await port()}`;
let cookie = '';
let csrf = '';
const credentials = { username: 'deployment-test', password: randomUUID() };
async function api(route, method = 'GET', data, raw = false) {
  const response = await fetch(`${origin}/admin/api/${route}`, {
    method,
    headers: {
      Cookie: cookie,
      Origin: origin,
      'X-CSRF-Token': csrf,
      'Content-Type': raw ? 'application/octet-stream' : 'application/json',
    },
    body: data === undefined ? undefined : raw ? data : JSON.stringify(data),
    signal: AbortSignal.timeout(10_000),
  });
  const value = await response.json();
  assert.ok(
    response.ok,
    `${route}: ${response.status} ${JSON.stringify(value)}`,
  );
  if (value.csrf) csrf = value.csrf;
  if (response.headers.has('set-cookie'))
    cookie = response.headers.get('set-cookie').split(';')[0];
  return value;
}
async function publish() {
  await api('publish', 'POST', {});
  for (let i = 0; i < 240; i++) {
    const state = await api('publication');
    if (!state.busy) {
      assert.equal(state.history[0].status, 'succeeded', state.history[0].log);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('Publication timed out.');
}
async function checksums(dir) {
  const lines = await Promise.all(
    bundleFiles.map(
      async (file) => `${await sha256(path.join(dir, file))}  ${file}\n`,
    ),
  );
  await writeFile(path.join(dir, 'SHA256SUMS'), lines.join(''));
}
async function derivative(version, failing = false) {
  const dir = path.join(temp, version);
  await mkdir(dir);
  for (const file of [...bundleFiles, 'SHA256SUMS'].filter(
    (file) => file !== 'images.tar',
  ))
    await cp(path.join(bundle, file), path.join(dir, file));
  const arch = source.RELEASE_PLATFORM.split('/')[1];
  const tag = `sparblog-admin:${version}-${arch}`;
  const caddyTag = `sparblog-caddy:${version}-${arch}`;
  const base = `${project}:base`;
  await docker('tag', source.APP_IMAGE, base);
  testImages.push(base, tag, caddyTag);
  await docker('tag', source.CADDY_IMAGE, caddyTag);
  const edit = `const fs=require('node:fs');const p='/app/src/layouts/SiteLayout.astro';fs.writeFileSync(p,fs.readFileSync(p,'utf8').replace('</footer>','<span>RELEASE_UPGRADE_TEST</span></footer>'));fs.writeFileSync('/app/src/data/settings/site.json',JSON.stringify({description:'NEW_DEFAULT',about:'NEW_DEFAULT'}));`;
  const context = path.join(temp, 'image-build');
  await mkdir(context, { recursive: true });
  await writeFile(
    path.join(context, 'Dockerfile'),
    `FROM ${base}\n${failing ? 'CMD ["node", "-e", "process.exit(1)"]' : `RUN ${JSON.stringify(['node', '-e', edit])}`}\n`,
  );
  await docker('build', '-t', tag, context);
  const manifest = await readFile(path.join(dir, 'release.env'), 'utf8');
  await writeFile(
    path.join(dir, 'release.env'),
    manifest
      .replace(/^RELEASE_VERSION=.*/m, `RELEASE_VERSION=${version}`)
      .replace(/^APP_IMAGE=.*/m, `APP_IMAGE=${tag}`)
      .replace(/^CADDY_IMAGE=.*/m, `CADDY_IMAGE=${caddyTag}`),
  );
  await docker(
    'image',
    'save',
    '--output',
    path.join(dir, 'images.tar'),
    tag,
    caddyTag,
  );
  await checksums(dir);
  return dir;
}
async function container(service) {
  return docker(
    'ps',
    '-aq',
    '--filter',
    `label=com.docker.compose.project=${project}`,
    '--filter',
    `label=com.docker.compose.service=${service}`,
  );
}

try {
  console.log('Deployment: first install and administrator initialization');
  await run('bash', [path.join(bundle, 'manage.sh'), 'install', root, origin], {
    env: {
      SPARBLOG_PROJECT: project,
      SPARBLOG_HTTPS_PORT: String(await port()),
    },
  });
  const localIDs = await readFile(
    path.join(root, 'releases', source.RELEASE_VERSION, 'runtime.env'),
    'utf8',
  );
  for (const key of ['APP_IMAGE', 'CADDY_IMAGE']) {
    const localID = await docker(
      'image',
      'inspect',
      '--format',
      '{{.Id}}',
      source[key],
    );
    assert.ok(
      localIDs.includes(`${key}=${localID}\n`),
      'Deployment must resolve and pin the target Docker image ID.',
    );
  }
  const logs = await docker('logs', await container('admin'));
  const token = logs.match(/#setup=([^\s]+)/)?.[1];
  assert.ok(token, 'First setup link missing.');
  await api('setup', 'POST', { ...credentials, token });
  let settings = await api('settings');
  settings = await api('settings', 'PUT', {
    ...settings,
    description: 'PERSISTED_DESCRIPTION',
    about: '## PERSISTED_ABOUT\n\nRetained on upgrade.',
  });
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/qcAAAAASUVORK5CYII=',
    'base64',
  );
  const media = await api('media', 'POST', png, true);
  await api('posts', 'POST', {
    slug: 'deployment-persistence',
    title: 'DEPLOYMENT_PERSISTENCE',
    description: 'Kept during upgrades',
    category: '部署测试',
    date: '2020-01-01',
    draft: false,
    example: false,
    body: `## Persistent article\n\n![test](${media.url})\n`,
  });
  await publish();
  const publicURL = `${origin}/notes/deployment-persistence/`;
  assert.equal((await fetch(publicURL)).status, 200);
  assert.equal((await fetch(`${origin}/.admin/account.json`)).status, 404);
  assert.equal((await fetch(`${origin}/not-found/`)).status, 404);
  assert.match(
    (await fetch(`${origin}/rss.xml`)).headers.get('content-type'),
    /xml/,
  );

  console.log(
    'Deployment: reject damaged, executable, wrong-architecture and duplicate releases',
  );
  const invalid = path.join(temp, 'invalid');
  await cp(bundle, invalid, { recursive: true });
  await writeFile(path.join(invalid, 'release.env'), 'damaged');
  assert.notEqual(
    (
      await run('bash', [path.join(root, 'manage.sh'), 'upgrade', invalid], {
        fail: true,
      })
    ).code,
    0,
  );
  const original = await readFile(path.join(bundle, 'release.env'), 'utf8');
  await writeFile(
    path.join(invalid, 'release.env'),
    original.replace(/^APP_IMAGE=.*/m, `APP_IMAGE=$(touch ${temp}/executed)`),
  );
  await checksums(invalid);
  assert.notEqual(
    (
      await run('bash', [path.join(root, 'manage.sh'), 'upgrade', invalid], {
        fail: true,
      })
    ).code,
    0,
  );
  assert.ok(!(await readdir(temp)).includes('executed'));
  const wrongPlatform =
    source.RELEASE_PLATFORM === 'linux/amd64' ? 'linux/arm64' : 'linux/amd64';
  await writeFile(
    path.join(invalid, 'release.env'),
    original
      .replace(source.RELEASE_PLATFORM, wrongPlatform)
      .replaceAll(
        `-${source.RELEASE_PLATFORM.split('/')[1]}`,
        `-${wrongPlatform.split('/')[1]}`,
      ),
  );
  await checksums(invalid);
  assert.notEqual(
    (
      await run('bash', [path.join(root, 'manage.sh'), 'upgrade', invalid], {
        fail: true,
      })
    ).code,
    0,
  );
  assert.notEqual(
    (
      await run('bash', [path.join(root, 'manage.sh'), 'upgrade', bundle], {
        fail: true,
      })
    ).code,
    0,
  );
  assert.equal(
    await readlink(path.join(root, 'current')),
    `releases/${source.RELEASE_VERSION}`,
  );
  await rm(invalid, { recursive: true });

  console.log(
    'Deployment: new image preserves accounts, settings, articles, media and public pages',
  );
  const upgraded = await derivative(upgradedVersion);
  const proxyBefore = await container('blog');
  let pollError;
  const poll = setInterval(() => {
    fetch(publicURL, { signal: AbortSignal.timeout(5000) })
      .then((r) => {
        if (r.status !== 200)
          pollError = new Error(`Public status: ${r.status}`);
      })
      .catch((e) => {
        pollError = e;
      });
  }, 200);
  try {
    await manage('upgrade', upgraded);
  } finally {
    clearInterval(poll);
  }
  assert.ifError(pollError);
  assert.equal(
    await container('blog'),
    proxyBefore,
    'Unchanged proxy should not be recreated.',
  );
  await api('login', 'POST', credentials);
  assert.equal((await api('settings')).description, settings.description);
  assert.match(
    (await api('posts/deployment-persistence')).body,
    /Persistent article/,
  );
  assert.equal((await fetch(`${origin}${media.url}`)).status, 200);
  assert.ok(
    !(await (await fetch(origin)).text()).includes('RELEASE_UPGRADE_TEST'),
  );
  await publish();
  assert.match(await (await fetch(origin)).text(), /RELEASE_UPGRADE_TEST/);

  console.log('Deployment: failed startup restores the previous program');
  const broken = await derivative(brokenVersion, true);
  const failed = await run(
    'bash',
    [path.join(root, 'manage.sh'), 'upgrade', broken],
    { fail: true },
  );
  assert.notEqual(failed.code, 0, 'Broken image must fail deployment.');
  assert.equal(
    await readlink(path.join(root, 'current')),
    `releases/${upgradedVersion}`,
  );
  await api('login', 'POST', credentials);
  assert.equal((await api('settings')).description, settings.description);
  assert.equal((await fetch(publicURL)).status, 200);

  console.log('Deployment: rollback and stopped-writer backup');
  await manage('rollback', source.RELEASE_VERSION);
  await api('login', 'POST', credentials);
  assert.equal((await api('settings')).description, settings.description);
  await publish();
  assert.ok(
    !(await (await fetch(origin)).text()).includes('RELEASE_UPGRADE_TEST'),
  );
  await manage('backup');
  const backups = await readdir(path.join(root, 'backups'));
  assert.ok(backups.length >= 4);
  const backup = path.join(root, 'backups', backups[0]);
  const listing = await run('tar', ['-tzf', path.join(backup, 'data.tar.gz')]);
  for (const expected of [
    'admin_state/account.json',
    'notes/deployment-persistence.md',
    'settings/site.json',
    'published/current',
  ])
    assert.ok(listing.output.includes(expected), expected);
  console.log(
    'Deployment smoke passed: install, publish, upgrade, recovery, rollback, backup, data retention.',
  );
} finally {
  // Only delete resources with the unique project label allocated by this test.
  const ids = await docker(
    'ps',
    '-aq',
    '--filter',
    `label=com.docker.compose.project=${project}`,
  );
  if (ids) await docker('rm', '-f', ...ids.split('\n'));
  const networks = await docker(
    'network',
    'ls',
    '-q',
    '--filter',
    `label=com.docker.compose.project=${project}`,
  );
  if (networks) await docker('network', 'rm', ...networks.split('\n'));
  const volumes = await docker(
    'volume',
    'ls',
    '-q',
    '--filter',
    `label=com.docker.compose.project=${project}`,
  );
  if (volumes) await docker('volume', 'rm', ...volumes.split('\n'));
  if (testImages.length)
    await run('docker', ['image', 'rm', ...new Set(testImages)], {
      fail: true,
    });
  await rm(temp, { recursive: true, force: true });
}
