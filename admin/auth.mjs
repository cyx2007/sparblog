import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';

const derive = promisify(scrypt);
export const token = () => randomBytes(32).toString('hex');
export function fail(status, message) {
  throw Object.assign(new Error(message), { status });
}
export function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function makeAccount(username, password) {
  if (typeof username !== 'string' || !/^[a-zA-Z0-9_-]{3,40}$/.test(username))
    fail(400, '账号需要 3–40 个英文字母、数字、下划线或连字符。');
  if (
    typeof password !== 'string' ||
    password.length < 12 ||
    password.length > 256
  )
    fail(400, '密码长度需要在 12–256 个字符之间。');
  const salt = token();
  const hash = await derive(password, salt, 64, {
    N: 32768,
    maxmem: 64 * 1024 * 1024,
  });
  return { username, salt, hash: hash.toString('hex') };
}

export async function checkPassword(account, password) {
  if (typeof password !== 'string' || password.length > 256) return false;
  const actual = await derive(password, account.salt, 64, {
    N: 32768,
    maxmem: 64 * 1024 * 1024,
  });
  return equal(actual.toString('hex'), account.hash);
}

export async function createAuth(stateDir, secure) {
  const accountPath = path.join(stateDir, 'account.json');
  let account;
  try {
    account = JSON.parse(await readFile(accountPath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const bootstrap = account ? null : token();
  const sessions = new Map();
  const attempts = new Map();
  const cookieName = 'sparsity_admin';
  const lifetime = 12 * 60 * 60 * 1000;

  function cookie(id, age = lifetime / 1000) {
    return `${cookieName}=${id}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=${age}${secure ? '; Secure' : ''}`;
  }
  function session(req) {
    const id = (req.headers.cookie || '')
      .split(';')
      .map((x) => x.trim())
      .find((x) => x.startsWith(`${cookieName}=`))
      ?.slice(cookieName.length + 1);
    const value = sessions.get(id);
    if (value?.expires > Date.now()) return { ...value, id };
    sessions.delete(id);
    return null;
  }
  function issue() {
    for (const [id, value] of sessions)
      if (value.expires <= Date.now()) sessions.delete(id);
    while (sessions.size >= 10) sessions.delete(sessions.keys().next().value);
    const id = token();
    const value = { csrf: token(), expires: Date.now() + lifetime };
    sessions.set(id, value);
    return { csrf: value.csrf, username: account.username, cookie: cookie(id) };
  }
  function limit(req) {
    const now = Date.now();
    for (const [key, value] of attempts)
      if (value.until <= now) attempts.delete(key);
    const key = req.socket.remoteAddress || 'unknown';
    const attempt = attempts.get(key) || {
      count: 0,
      until: now + 15 * 60 * 1000,
    };
    if (++attempt.count > 10) fail(429, '登录尝试过多，请在 15 分钟后重试。');
    if (attempts.size >= 1000 && !attempts.has(key))
      fail(429, '请求过多，请稍后重试。');
    attempts.set(key, attempt);
  }
  async function persist(next, initial) {
    if (initial)
      await writeFile(accountPath, JSON.stringify(next), {
        flag: 'wx',
        mode: 0o600,
      });
    else {
      const temp = `${accountPath}.${token()}.tmp`;
      await writeFile(temp, JSON.stringify(next), { mode: 0o600 });
      await rename(temp, accountPath);
    }
    account = next;
    sessions.clear();
  }
  return {
    bootstrap,
    get configured() {
      return Boolean(account);
    },
    get username() {
      return account?.username;
    },
    session,
    require(req, write = false) {
      const value = session(req);
      if (!value) fail(401, '请先登录，或重新登录已过期的会话。');
      if (write && !equal(req.headers['x-csrf-token'], value.csrf))
        fail(403, '请求校验失败，请刷新页面后重试。');
      return value;
    },
    async setup(req, data) {
      limit(req);
      if (account) fail(409, '管理员已创建，请登录。');
      if (!equal(data.token, bootstrap))
        fail(403, '初始化链接无效，请使用后台启动时显示的链接。');
      await persist(await makeAccount(data.username, data.password), true);
      attempts.clear();
      return issue();
    },
    async login(req, data) {
      limit(req);
      if (!account) fail(409, '请先使用初始化链接创建管理员。');
      const valid = await checkPassword(account, data.password);
      if (!equal(data.username, account.username) || !valid)
        fail(401, '账号或密码不正确。');
      attempts.delete(req.socket.remoteAddress || 'unknown');
      return issue();
    },
    logout(req) {
      sessions.delete(session(req)?.id);
      return cookie('', 0);
    },
    async changePassword(req, data) {
      limit(req);
      if (!(await checkPassword(account, data.currentPassword)))
        fail(400, '当前密码不正确。');
      await persist(await makeAccount(account.username, data.password), false);
      attempts.clear();
      return issue();
    },
  };
}
