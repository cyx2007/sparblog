import { execFileSync } from 'node:child_process';
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  bundleFiles,
  dockerPlatform,
  parseRelease,
  platformName,
  releaseVersion,
  sha256,
} from './release-utils.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
if (args.length !== 2)
  throw new Error('Usage: npm run release:docker -- v1.0.0 linux/amd64');
const version = releaseVersion(args[0]);
const platform = platformName(args[1]);
const arch = platform.split('/')[1];
const name = `sparblog-${version}-linux-${arch}`;
const out = path.resolve(
  process.env.RELEASE_OUTPUT_DIR || path.join(root, 'artifacts'),
);
const archive = path.join(out, `${name}.tar.gz`);
await mkdir(out, { recursive: true });
if (await stat(archive).catch(() => null))
  throw new Error(`Release already exists: ${archive}`);
const docker = (args, capture = false) =>
  execFileSync('docker', args, {
    cwd: root,
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    encoding: 'utf8',
  });
const host = dockerPlatform(
  docker(['info', '--format', '{{.OSType}}/{{.Architecture}}'], true),
);
if (host !== platform)
  throw new Error(`Build on a native ${platform} Docker host; found ${host}.`);
const appTag = `sparblog-admin:${version}-${arch}`;
const caddyTag = `sparblog-caddy:${version}-${arch}`;
const revision =
  process.env.GITHUB_SHA || process.env.RELEASE_REVISION || 'local';
docker([
  'build',
  '--pull',
  '--platform',
  platform,
  '-f',
  'Dockerfile.admin',
  '-t',
  appTag,
  '--label',
  `org.opencontainers.image.version=${version}`,
  '--label',
  `org.opencontainers.image.revision=${revision}`,
  '--label',
  'org.opencontainers.image.source=https://github.com/cyx2007/sparblog',
  '.',
]);
docker(['pull', '--platform', platform, 'caddy:2-alpine']);
docker(['tag', 'caddy:2-alpine', caddyTag]);
function imageID(tag) {
  const [info] = JSON.parse(docker(['image', 'inspect', tag], true));
  if (`${info.Os}/${info.Architecture}` !== platform)
    throw new Error(`Wrong architecture: ${tag}`);
  return info.Id;
}
const manifest = {
  RELEASE_VERSION: version,
  RELEASE_PLATFORM: platform,
  DATA_SCHEMA: '1',
  APP_IMAGE: imageID(appTag),
  CADDY_IMAGE: imageID(caddyTag),
};
const manifestText = Object.entries(manifest)
  .map(([key, value]) => `${key}=${value}\n`)
  .join('');
parseRelease(manifestText);
const temp = await mkdtemp(path.join(tmpdir(), 'sparblog-release-'));
try {
  const bundle = path.join(temp, name);
  await mkdir(bundle);
  for (const [source, target] of [
    ['deploy/Caddyfile.container', 'Caddyfile'],
    ['deploy/compose.release.yaml', 'compose.yaml'],
    ['deploy/manage.sh', 'manage.sh'],
    ['deploy/RELEASES.md', 'README.md'],
  ])
    await cp(path.join(root, source), path.join(bundle, target));
  await chmod(path.join(bundle, 'manage.sh'), 0o755);
  await writeFile(path.join(bundle, 'release.env'), manifestText);
  docker([
    'image',
    'save',
    '--output',
    path.join(bundle, 'images.tar'),
    appTag,
    caddyTag,
  ]);
  const checksums = await Promise.all(
    bundleFiles.map(
      async (file) => `${await sha256(path.join(bundle, file))}  ${file}\n`,
    ),
  );
  await writeFile(path.join(bundle, 'SHA256SUMS'), checksums.join(''));
  execFileSync('tar', ['-czf', `${archive}.partial`, '-C', temp, name], {
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
  const { rename } = await import('node:fs/promises');
  await rename(`${archive}.partial`, archive);
  await writeFile(
    `${archive}.sha256`,
    `${await sha256(archive)}  ${path.basename(archive)}\n`,
  );
  console.log(`Release bundle: ${archive}`);
} finally {
  await rm(temp, { recursive: true, force: true });
  await rm(`${archive}.partial`, { force: true });
}
