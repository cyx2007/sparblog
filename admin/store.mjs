import { createHash, randomUUID } from 'node:crypto';
import {
  readdir,
  readFile,
  writeFile,
  mkdir,
  lstat,
  rename,
  unlink,
  stat,
} from 'node:fs/promises';
import path from 'node:path';
import { parseDocument, Document } from 'yaml';
import { noteSchema } from '../src/lib/note-schema.mjs';
import { siteSettingsSchema } from '../src/lib/site-settings-schema.mjs';
import { fail } from './auth.mjs';

export const digest = (value) =>
  createHash('sha256').update(value).digest('hex');
export const MAX_BODY = 512 * 1024;
export const BUILD_INPUTS = [
  'src',
  'public',
  'astro.config.mjs',
  'tsconfig.json',
  'package.json',
];
export const MAX_IMAGE = 8 * 1024 * 1024;
const fields = [
  'title',
  'description',
  'date',
  'updated',
  'category',
  'excerpt',
  'draft',
  'example',
];

export async function atomicWrite(file, value, mode = 0o600) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, value, { flag: 'wx', mode });
    await rename(temp, file);
  } finally {
    await unlink(temp).catch(() => {});
  }
}

// Reject symlinks as well as traversal, including symlinked parent directories.
export async function safePath(base, relative, missing = false) {
  if (
    !relative ||
    relative.includes('\\') ||
    relative.includes('\0') ||
    relative
      .split('/')
      .some((x) => !x || x === '.' || x === '..' || x.startsWith('.'))
  )
    fail(400, '文件路径无效。');
  let current = base;
  const parts = relative.split('/');
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) fail(400, '不支持符号链接文件。');
      if (i < parts.length - 1 && !info.isDirectory())
        fail(400, '文件路径无效。');
    } catch (error) {
      if (error.code === 'ENOENT' && missing && i === parts.length - 1)
        return current;
      if (error.code === 'ENOENT') fail(404, '文件不存在。');
      throw error;
    }
  }
  return current;
}

async function walk(dir, prefix = '') {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    if (entry.isSymbolicLink())
      fail(400, '内容目录中存在符号链接，请移除后重试。');
    const relative = prefix + entry.name;
    if (entry.isDirectory())
      files.push(...(await walk(path.join(dir, entry.name), `${relative}/`)));
    else if (entry.isFile()) files.push(relative);
  }
  return files.sort();
}

function parse(source) {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) fail(400, '文章缺少 YAML 元数据。');
  const doc = parseDocument(match[1]);
  if (doc.errors.length)
    fail(400, `文章元数据格式错误：${doc.errors[0].message}`);
  let raw;
  try {
    raw = doc.toJS({ maxAliasCount: 50 });
  } catch {
    fail(400, '文章元数据过于复杂。');
  }
  const result = noteSchema.safeParse(raw);
  if (!result.success)
    fail(
      400,
      `文章字段无效：${result.error.issues.map((x) => x.path.join('.')).join('、')}`,
    );
  return {
    doc,
    data: result.data,
    body: source.slice(match[0].length).replace(/^\r?\n/, ''),
  };
}

function validate(input) {
  if (!input || typeof input !== 'object') fail(400, '文章数据无效。');
  for (const key of ['date', 'updated']) {
    if (input[key] === undefined) continue;
    const value = input[key];
    if (
      typeof value !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z)?$/.test(value) ||
      !Number.isFinite(Date.parse(value)) ||
      new Date(value).toISOString().slice(0, 10) !== value.slice(0, 10)
    )
      fail(400, '日期需要是有效的 YYYY-MM-DD，或带 Z 的 UTC 时间。');
  }
  const result = noteSchema.safeParse(input);
  if (!result.success)
    fail(
      400,
      `请检查文章字段：${result.error.issues.map((x) => x.path.join('.')).join('、')}。更新日期不得早于发表日期。`,
    );
  if (
    typeof input.body !== 'string' ||
    Buffer.byteLength(input.body) > MAX_BODY
  )
    fail(400, '正文最多为 512 KB。');
  if (
    input.title.length > 240 ||
    input.description.length > 2000 ||
    input.category.length > 80
  )
    fail(400, '标题、摘要或分类过长。');
  return { ...result.data, body: input.body };
}

export function imageType(buffer) {
  if (
    buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return { ext: 'png', mime: 'image/png' };
  if (buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255)
    return { ext: 'jpg', mime: 'image/jpeg' };
  if (/^GIF8[79]a$/.test(buffer.subarray(0, 6).toString()))
    return { ext: 'gif', mime: 'image/gif' };
  if (
    buffer.subarray(0, 4).toString() === 'RIFF' &&
    buffer.subarray(8, 12).toString() === 'WEBP'
  )
    return { ext: 'webp', mime: 'image/webp' };
  fail(400, '仅支持 PNG、JPEG、GIF、WebP 图片。');
}

export async function createStore(root, stateDir) {
  const notesDir = path.join(root, 'src/content/notes');
  const mediaDir = path.join(root, 'public/images');
  const trashDir = path.join(stateDir, 'trash');
  await mkdir(mediaDir, { recursive: true });
  await mkdir(trashDir, { recursive: true, mode: 0o700 });
  for (const directory of [notesDir, mediaDir]) {
    if ((await lstat(directory)).isSymbolicLink())
      fail(400, '内容根目录不能是符号链接。');
  }
  function slug(value, creating = false) {
    if (
      typeof value !== 'string' ||
      value.length > 180 ||
      !value
        .split('/')
        .every((part) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(part)) ||
      (creating && value.includes('/'))
    )
      fail(400, '文章路径请使用小写字母、数字和连字符。');
    return value;
  }
  async function get(id) {
    const file = await safePath(notesDir, `${slug(id)}.md`);
    const source = await readFile(file, 'utf8');
    const { data, body } = parse(source);
    return { slug: id, ...data, body, revision: digest(source) };
  }
  async function list() {
    return (
      await Promise.all(
        (await walk(notesDir))
          .filter((x) => x.endsWith('.md'))
          .map((file) => get(file.slice(0, -3))),
      )
    ).sort((a, b) => b.date - a.date || a.slug.localeCompare(b.slug));
  }
  async function trash() {
    return (
      await Promise.all(
        (await readdir(trashDir))
          .filter((x) => /^[\da-f-]+\.json$/.test(x))
          .map(async (file) => {
            const item = JSON.parse(
              await readFile(path.join(trashDir, file), 'utf8'),
            );
            return {
              id: file.slice(0, -5),
              slug: item.slug,
              title: parse(item.source).data.title,
              deletedAt: item.deletedAt,
            };
          }),
      )
    ).sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
  }
  async function media() {
    return Promise.all(
      (await walk(mediaDir)).map(async (name) => {
        const file = path.join(mediaDir, name);
        return {
          name,
          url: `/images/${name.split('/').map(encodeURIComponent).join('/')}`,
          size: (await stat(file)).size,
        };
      }),
    );
  }
  async function settings() {
    const file = await safePath(root, 'src/data/settings/site.json');
    const source = await readFile(file, 'utf8');
    const data = siteSettingsSchema.parse(JSON.parse(source));
    return { ...data, revision: digest(source) };
  }
  return {
    notesDir,
    mediaDir,
    list,
    get,
    trash,
    media,
    settings,
    async saveSettings(input) {
      const { revision, ...values } = input;
      const result = siteSettingsSchema.safeParse(values);
      if (!result.success)
        fail(400, '网站介绍需要 1–240 个字符，关于正文最多 100,000 个字符。');
      const file = await safePath(root, 'src/data/settings/site.json');
      if (revision !== digest(await readFile(file, 'utf8')))
        fail(
          409,
          '网站设置已在其他窗口或文件中修改。请先复制当前内容，再重新打开设置。',
        );
      await atomicWrite(
        file,
        `${JSON.stringify(result.data, null, 2)}\n`,
        0o644,
      );
      return settings();
    },
    async save(id, input, creating) {
      slug(id, creating);
      const data = validate(input);
      const file = await safePath(notesDir, `${id}.md`, true);
      let doc = new Document();
      if (!creating) {
        const previous = await readFile(file, 'utf8');
        if (input.revision !== digest(previous))
          fail(
            409,
            '文章已在其他窗口或文件中修改。请先复制当前内容，再重新打开文章。',
          );
        doc = parse(previous).doc;
      }
      for (const key of fields) {
        if (data[key] === undefined) doc.delete(key);
        else
          doc.set(
            key,
            data[key] instanceof Date ? data[key].toISOString() : data[key],
          );
      }
      const source = `---\n${doc.toString({ lineWidth: 0 })}---\n\n${data.body}${data.body.endsWith('\n') ? '' : '\n'}`;
      if (creating) {
        try {
          await writeFile(file, source, { flag: 'wx' });
        } catch (error) {
          if (error.code === 'EEXIST')
            fail(409, '这个文章路径已存在，请换一个。');
          throw error;
        }
      } else await atomicWrite(file, source, 0o644);
      return get(id);
    },
    async remove(id, revision) {
      const file = await safePath(notesDir, `${slug(id)}.md`);
      const source = await readFile(file, 'utf8');
      if (revision !== digest(source))
        fail(409, '文章已有更新，请刷新列表后重试。');
      const item = { slug: id, source, deletedAt: new Date().toISOString() };
      await writeFile(
        path.join(trashDir, `${randomUUID()}.json`),
        JSON.stringify(item),
        { flag: 'wx', mode: 0o600 },
      );
      await unlink(file);
    },
    async restore(id) {
      if (!/^[\da-f-]{36}$/.test(id)) fail(400, '回收站记录无效。');
      const file = await safePath(trashDir, `${id}.json`);
      const item = JSON.parse(await readFile(file, 'utf8'));
      const target = await safePath(notesDir, `${slug(item.slug)}.md`, true);
      try {
        await writeFile(target, item.source, { flag: 'wx' });
      } catch (error) {
        if (error.code === 'EEXIST')
          fail(409, '同名文章已存在，恢复不会覆盖它。');
        throw error;
      }
      await unlink(file);
      return get(item.slug);
    },
    async upload(buffer) {
      if (!buffer.length || buffer.length > MAX_IMAGE)
        fail(413, '图片大小需要在 1 字节到 8 MB 之间。');
      const type = imageType(buffer);
      const name = `${new Date().toISOString().slice(0, 10)}-${randomUUID()}.${type.ext}`;
      await writeFile(path.join(mediaDir, name), buffer, { flag: 'wx' });
      return { name, url: `/images/${name}`, size: buffer.length };
    },
    async removeMedia(name) {
      const file = await safePath(mediaDir, name);
      const url = `/images/${name}`;
      const about = (await settings()).about;
      const references = (await list()).filter(
        (post) => post.body.includes(url) || post.body.includes(encodeURI(url)),
      );
      const archived = await Promise.all(
        (await readdir(trashDir))
          .filter((x) => x.endsWith('.json'))
          .map((x) => readFile(path.join(trashDir, x), 'utf8')),
      );
      if (
        references.length ||
        about.includes(url) ||
        about.includes(encodeURI(url)) ||
        archived.some((x) => x.includes(url) || x.includes(encodeURI(url)))
      )
        fail(409, '这张图片仍被文章、关于页面或回收站内容引用，暂不能删除。');
      await unlink(file);
    },
    async fingerprint() {
      const entries = [];
      for (const input of BUILD_INPUTS) {
        const base = await safePath(root, input);
        const files = (await stat(base)).isDirectory()
          ? (await walk(base)).map((file) => path.join(base, file))
          : [base];
        for (const file of files)
          entries.push([
            path.relative(root, file),
            digest(await readFile(file)),
          ]);
      }
      return digest(JSON.stringify(entries));
    },
  };
}
