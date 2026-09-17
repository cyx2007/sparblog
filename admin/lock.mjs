import { readFile, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const owned = new Set();
export async function claimLock(stateDir) {
  const file = path.join(stateDir, 'server.lock');
  const owner = { pid: process.pid, token: randomUUID() };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeFile(file, JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
      owned.add(file);
      return async () => {
        if (JSON.parse(await readFile(file, 'utf8')).token === owner.token)
          await unlink(file);
        owned.delete(file);
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const previous = JSON.parse(await readFile(file, 'utf8'));
      if (previous.pid === process.pid) {
        if (owned.has(file)) throw new Error('此内容目录的后台已在运行。');
      } else {
        try {
          process.kill(previous.pid, 0);
          throw new Error('此内容目录的后台已在运行，请勿启动多个实例。');
        } catch (error) {
          if (error.code !== 'ESRCH') throw error;
        }
      }
      await unlink(file);
    }
  }
  throw new Error('无法取得后台运行锁，请确认没有其他后台实例。');
}
