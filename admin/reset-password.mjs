import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeAccount } from './auth.mjs';
import { atomicWrite } from './store.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const stateDir = path.resolve(root, process.env.ADMIN_STATE_DIR || '.admin');
if (!process.stdin.isTTY) throw new Error('请在交互式终端运行密码重置。');
try {
  const lock = JSON.parse(
    await readFile(path.join(stateDir, 'server.lock'), 'utf8'),
  );
  try {
    process.kill(lock.pid, 0);
    throw new Error('请先停止后台服务，再重置密码。');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const accountPath = path.join(stateDir, 'account.json');
const account = JSON.parse(await readFile(accountPath, 'utf8'));
const output = new Writable({
  write(_chunk, _encoding, callback) {
    callback();
  },
});
const input = createInterface({ input: process.stdin, output, terminal: true });
try {
  process.stdout.write(`为 ${account.username} 设置新密码（至少 12 个字符）：`);
  const password = await input.question('');
  process.stdout.write('\n再次输入新密码：');
  const confirmation = await input.question('');
  process.stdout.write('\n');
  if (password !== confirmation)
    throw new Error('两次密码不一致，未修改账号。');
  await atomicWrite(
    accountPath,
    JSON.stringify(await makeAccount(account.username, password)),
  );
  console.log('密码已重置，可以重新启动后台。');
} finally {
  input.close();
}
