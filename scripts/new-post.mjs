import { writeFile } from 'node:fs/promises';
import path from 'node:path';

const [slug, title] = process.argv.slice(2);
if (!slug || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || !title?.trim()) {
  console.error('Usage: npm run new:post -- my-first-note "文章标题"');
  console.error('Use lowercase letters, numbers and hyphens for the URL slug.');
  process.exit(1);
}
const destination = path.resolve('src/content/notes', `${slug}.md`);
const content = `---
title: ${JSON.stringify(title.trim())}
description: '在这里写一两句摘要。'
date: ${new Date().toISOString().slice(0, 10)}
category: 随想
draft: true
---

从这里开始写正文。
`;
try {
  await writeFile(destination, content, { flag: 'wx' });
  console.log(`Created draft: ${destination}`);
  console.log('Set draft: false when the article is ready, then rebuild.');
} catch (error) {
  if (error.code === 'EEXIST') {
    console.error(`Already exists: ${destination}. No file was overwritten.`);
    process.exit(1);
  }
  throw error;
}
