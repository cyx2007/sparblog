import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  readlink,
} from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { atomicWrite, BUILD_INPUTS } from './store.mjs';
import { fail } from './auth.mjs';

export async function createPublisher(root, stateDir, publishDir, store) {
  await mkdir(path.join(stateDir, 'work'), { recursive: true, mode: 0o700 });
  await mkdir(path.join(publishDir, 'releases'), { recursive: true });
  const recordPath = path.join(stateDir, 'publication.json');
  let record = {
    manifest: {},
    fingerprint: null,
    publishedAt: null,
    history: [],
  };
  try {
    record = JSON.parse(await readFile(recordPath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  for (const job of record.history)
    if (job.status === 'running') {
      job.status = 'failed';
      job.log += '\n服务已重启，请重新构建。';
    }
  let busy = false;
  let work;
  const persist = () => atomicWrite(recordPath, JSON.stringify(record));
  function run(args, cwd, job) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, args, {
        cwd,
        env: { ...process.env, ASTRO_TELEMETRY_DISABLED: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, 180_000);
      const append = (chunk) => {
        job.log = (
          job.log + chunk.toString().replace(/\x1b\[[0-9;]*m/g, '')
        ).slice(-64000);
      };
      child.stdout.on('data', append);
      child.stderr.on('data', append);
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else
          reject(
            new Error(
              timedOut
                ? '构建超过 3 分钟，已停止。'
                : `检查未通过（退出码 ${code}）。`,
            ),
          );
      });
    });
  }
  async function build(job) {
    let temp;
    let release;
    let switched = false;
    try {
      const fingerprint = await store.fingerprint();
      const posts = await store.list();
      temp = await mkdtemp(path.join(stateDir, 'work/build-'));
      for (const file of BUILD_INPUTS)
        await cp(path.join(root, file), path.join(temp, file), {
          recursive: true,
        });
      await symlink(
        path.join(root, 'node_modules'),
        path.join(temp, 'node_modules'),
        'dir',
      );
      const cli = path.join(root, 'node_modules/astro/bin/astro.mjs');
      await run([cli, 'check', '--root', temp], temp, job);
      await run([cli, 'build', '--root', temp], temp, job);
      await run([path.join(root, 'scripts/verify-build.mjs')], temp, job);
      if ((await store.fingerprint()) !== fingerprint)
        throw new Error('构建期间源文件被外部工具修改，请重新构建。');
      const visible = new Set(
        JSON.parse(
          await readFile(path.join(temp, 'dist/search-index.json'), 'utf8'),
        ).map((item) => item.url),
      );
      release = path.join(publishDir, 'releases', job.id);
      await cp(path.join(temp, 'dist'), release, { recursive: true });
      const next = path.join(publishDir, `.next-${job.id}`);
      try {
        await symlink(`releases/${job.id}`, next, 'dir');
        await rename(next, path.join(publishDir, 'current'));
      } finally {
        await rm(next, { force: true });
      }
      switched = true;
      record.fingerprint = fingerprint;
      record.publishedAt = new Date().toISOString();
      record.manifest = Object.fromEntries(
        posts
          .filter((post) =>
            visible.has(
              `/notes/${post.slug.split('/').map(encodeURIComponent).join('/')}/`,
            ),
          )
          .map((post) => [post.slug, post.revision]),
      );
      job.status = 'succeeded';
      job.log += '\n检查通过，公开版本已切换。\n';
    } catch (error) {
      job.status = 'failed';
      job.log += `\n${error.message}\n${switched ? '版本已切换，但记录写入失败，请检查磁盘。' : '上一公开版本保持不变。'}\n`;
      if (release && !switched)
        await rm(release, { recursive: true, force: true }).catch(() => {});
    } finally {
      job.finishedAt = new Date().toISOString();
      if (temp)
        await rm(temp, { recursive: true, force: true }).catch(() => {});
      try {
        await persist();
      } finally {
        busy = false;
      }
    }
  }
  return {
    get busy() {
      return busy;
    },
    async info() {
      const due = (await store.list()).some(
        (post) =>
          !post.draft &&
          post.date.valueOf() <= Date.now() &&
          record.manifest[post.slug] !== post.revision,
      );
      return {
        busy,
        pending: due || record.fingerprint !== (await store.fingerprint()),
        publishedAt: record.publishedAt,
        manifest: record.manifest,
        history: record.history,
      };
    },
    async start() {
      if (busy) fail(409, '已有构建正在运行，请等待完成。');
      const job = {
        id: `${Date.now()}-${randomUUID()}`,
        status: 'running',
        startedAt: new Date().toISOString(),
        finishedAt: null,
        log: '正在检查并构建网站…\n',
      };
      busy = true;
      record.history = [job, ...record.history].slice(0, 10);
      try {
        await persist();
      } catch (error) {
        busy = false;
        throw error;
      }
      work = build(job).catch((error) => {
        console.error('Cannot save publication record:', error.message);
      });
      return { id: job.id };
    },
    async current() {
      try {
        const relative = await readlink(path.join(publishDir, 'current'));
        if (!/^releases\/[\d]+-[\da-f-]{36}$/.test(relative)) return null;
        return path.join(publishDir, relative);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        return null;
      }
    },
    async idle() {
      await work;
    },
  };
}
