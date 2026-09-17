import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseRelease,
  platformName,
  releaseVersion,
} from '../scripts/release-utils.mjs';

const manifest =
  [
    'RELEASE_VERSION=v1.0.0',
    'RELEASE_PLATFORM=linux/amd64',
    'DATA_SCHEMA=1',
    'APP_IMAGE=sparblog-admin:v1.0.0-amd64',
    'CADDY_IMAGE=sparblog-caddy:v1.0.0-amd64',
  ].join('\n') + '\n';

test('release metadata rejects paths, shell expressions, floating images and unknown schemas', () => {
  assert.equal(parseRelease(manifest).RELEASE_VERSION, 'v1.0.0');
  for (const version of [
    '../v1.0.0',
    'v1.0.0/../../tmp',
    'latest',
    'v1.0.0;id',
    'v1.0.0\n',
  ])
    assert.throws(() => releaseVersion(version));
  for (const platform of ['linux/386', 'darwin/arm64', 'linux/amd64;id'])
    assert.throws(() => platformName(platform));
  for (const invalid of [
    manifest + 'DATA_SCHEMA=1\n',
    manifest + 'EXTRA=$(id)\n',
    manifest.replace('DATA_SCHEMA=1', 'DATA_SCHEMA=2'),
    manifest.replace(/APP_IMAGE=.*/, 'APP_IMAGE=caddy:latest'),
    manifest.replace(/APP_IMAGE=.*/, 'APP_IMAGE=sparblog-admin:v2.0.0-amd64'),
    manifest.replace(
      /CADDY_IMAGE=.*/,
      'CADDY_IMAGE=sparblog-caddy:v1.0.0-arm64',
    ),
    manifest.replace(/APP_IMAGE=.*/, 'APP_IMAGE=$(id)'),
    manifest.replace('RELEASE_VERSION=v1.0.0', 'RELEASE_VERSION=../../etc'),
    manifest.replace(/CADDY_IMAGE=.*\n/, ''),
  ])
    assert.throws(() => parseRelease(invalid));
});
