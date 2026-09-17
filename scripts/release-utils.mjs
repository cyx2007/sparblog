import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

export const bundleFiles = [
  'Caddyfile',
  'README.md',
  'compose.yaml',
  'images.tar',
  'manage.sh',
  'release.env',
];

export function releaseVersion(value) {
  if (
    typeof value !== 'string' ||
    value.trim() !== value ||
    !/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(value)
  )
    throw new Error(
      'Version must be vMAJOR.MINOR.PATCH, optionally with a prerelease suffix.',
    );
  return value;
}

export function platformName(value) {
  if (!['linux/amd64', 'linux/arm64'].includes(value))
    throw new Error('Only linux/amd64 and linux/arm64 are supported.');
  return value;
}

export function dockerPlatform(value) {
  return value
    .trim()
    .replace('/aarch64', '/arm64')
    .replace('/x86_64', '/amd64');
}

export async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export function parseRelease(text) {
  const expected = [
    'RELEASE_VERSION',
    'RELEASE_PLATFORM',
    'DATA_SCHEMA',
    'APP_IMAGE',
    'CADDY_IMAGE',
  ];
  const values = {};
  for (const line of text.trim().split('\n')) {
    const match = line.match(/^([A-Z_]+)=([^\s=]+)$/);
    if (!match || !expected.includes(match[1]) || match[1] in values)
      throw new Error('Invalid release manifest.');
    values[match[1]] = match[2];
  }
  if (Object.keys(values).length !== expected.length)
    throw new Error('Incomplete release manifest.');
  releaseVersion(values.RELEASE_VERSION);
  platformName(values.RELEASE_PLATFORM);
  if (values.DATA_SCHEMA !== '1') throw new Error('Unsupported data schema.');
  for (const key of ['APP_IMAGE', 'CADDY_IMAGE'])
    if (!/^sha256:[a-f0-9]{64}$/.test(values[key]))
      throw new Error('Images must be pinned by ID.');
  return values;
}
