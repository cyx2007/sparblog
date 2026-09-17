import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import { fixture, png, root } from './admin-fixture.mjs';

const ctx = await fixture();
const screenshots = path.join(root, 'test-results');
await mkdir(screenshots, { recursive: true });
let browser;
try {
  browser = await chromium.launch({
    channel: process.env.ADMIN_TEST_BROWSER || undefined,
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  const externalRequests = [];
  page.on('request', (request) => {
    if (!request.url().startsWith(ctx.app.origin))
      externalRequests.push(request.url());
  });
  const markdownInput = page.locator(
    '#post-form .CodeMirror [contenteditable=true]',
  );
  async function setBody(text) {
    await markdownInput.focus();
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.insertText(text);
    await expect(page.locator('#post-body')).toHaveValue(text);
  }
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (
      message.type() === 'error' &&
      /Content Security Policy/.test(message.text()) &&
      !/script/.test(message.text())
    )
      errors.push(message.text());
  });
  await page.goto(`${ctx.app.origin}/admin/#setup=${ctx.app.bootstrap}`);
  await expect(page.getByRole('heading', { name: '创建管理员' })).toBeVisible();
  await page
    .locator('#auth-form [name=password]')
    .fill('browser-check-password');
  await page
    .locator('#auth-form [name=confirm]')
    .fill('browser-check-password');
  await page.getByRole('button', { name: '创建并登录' }).click();
  await expect(page.locator('#workspace')).toBeVisible();
  await expect(page.locator('.admin-post-row')).toHaveCount(6);
  await page.screenshot({
    path: path.join(screenshots, 'admin-desktop.png'),
    fullPage: true,
  });
  await page.getByRole('searchbox', { name: '搜索文章' }).fill('1000 × 1000');
  await expect(page.locator('.admin-post-row')).toHaveCount(1);
  await page.getByRole('searchbox', { name: '搜索文章' }).fill('');
  // Reproduce the sample article from the reported screenshot at both widths.
  await page
    .getByRole('button', { name: '少一点，但想清楚一点', exact: true })
    .click();
  const codeLines = page.locator('.CodeMirror-code .admin-code-line');
  const codeBackgrounds = page.locator(
    '.CodeMirror-code .admin-code-background',
  );
  async function checkCodeBackgrounds(count) {
    await expect(codeBackgrounds).toHaveCount(count);
    const boxes = await codeBackgrounds.evaluateAll((elements) =>
      elements.map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          top: rect.top,
          bottom: rect.bottom,
          width: rect.width,
          color: getComputedStyle(element).backgroundColor,
        };
      }),
    );
    assert.notEqual(boxes[0].color, 'rgba(0, 0, 0, 0)');
    for (let index = 1; index < boxes.length; index++) {
      assert.equal(boxes[index].color, boxes[0].color);
      assert.equal(boxes[index].width, boxes[0].width);
      assert.ok(
        Math.abs(boxes[index].top - boxes[index - 1].bottom) < 1,
        'Code block backgrounds must join without gaps, including blank lines',
      );
    }
    const tokenBackgrounds = await codeLines
      .locator('.cm-comment')
      .evaluateAll((elements) =>
        elements.map((element) => getComputedStyle(element).backgroundColor),
      );
    assert.ok(
      tokenBackgrounds.every((color) => color === 'rgba(0, 0, 0, 0)'),
      'Code tokens must not have individual gray backgrounds inside a block',
    );
  }
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    await page.locator('.CodeMirror').scrollIntoViewIfNeeded();
    await page.locator('.CodeMirror').evaluate((element) => {
      const cm = element.CodeMirror;
      const line = cm.getValue().split('\n').indexOf('```text');
      cm.refresh();
      cm.scrollIntoView(
        { from: { line, ch: 0 }, to: { line: line + 3, ch: 3 } },
        40,
      );
    });
    await expect(codeLines.last()).toBeInViewport();
    await checkCodeBackgrounds(4);
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
      'The sample code block must wrap on mobile without page overflow',
    );
    await page.locator('.CodeMirror').screenshot({
      path: path.join(screenshots, `admin-code-block-${width}.png`),
    });
  }
  await page.getByRole('button', { name: '预览', exact: true }).click();
  await expect(
    page.frameLocator('#preview-frame').locator('pre code'),
  ).toHaveText(
    'thoughts = observations + questions + time\nnotes    = keep(thoughts, when = worth_revisiting)',
  );
  await page.getByRole('button', { name: '← 返回文章' }).click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: '新建文章' }).click();
  await page.locator('#post-form [name=title]').fill('浏览器验证文章');
  await page.locator('#post-form [name=slug]').fill('browser-check');
  await page.locator('#post-form [name=category]').fill('测试');
  await page
    .locator('#post-form [name=description]')
    .fill('验证编辑、预览、保存和发布流程。');
  await page.locator('#post-form [name=date]').fill('2020-01-01');
  await expect(markdownInput).toBeVisible();
  await setBody('格式测试');
  await page.keyboard.press('ControlOrMeta+A');
  await page.getByRole('button', { name: '加粗', exact: true }).click();
  await expect(page.locator('#post-body')).toHaveValue('**格式测试**');
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(page.locator('#post-body')).toHaveValue('格式测试');
  await page.getByRole('button', { name: '重做', exact: true }).click();
  await expect(page.locator('#post-body')).toHaveValue('**格式测试**');
  await setBody('快捷键测试');
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('ControlOrMeta+B');
  await expect(page.locator('#post-body')).toHaveValue('**快捷键测试**');
  await setBody('- 第一项');
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.insertText('第二项');
  await expect(page.locator('#post-body')).toHaveValue('- 第一项\n- 第二项');
  await setBody('链接文字');
  await page.keyboard.press('ControlOrMeta+A');
  page.once('dialog', (dialog) => dialog.accept('https://example.com'));
  await page.getByRole('button', { name: '插入链接', exact: true }).click();
  await expect(page.locator('#post-body')).toHaveValue(
    '[链接文字](https://example.com)',
  );
  await setBody('');
  await page.getByRole('button', { name: '插入表格', exact: true }).click();
  await expect(page.locator('#post-body')).toHaveValue(/\| 列名 \| 列名 \|/);
  await setBody('const answer = 42;\nconsole.log(answer);');
  await page.keyboard.press('ControlOrMeta+A');
  await page.getByRole('button', { name: '代码', exact: true }).click();
  await expect(page.locator('#post-body')).toHaveValue(
    /```[\s\S]*const answer = 42;[\s\S]*```/,
  );
  const fencedBody =
    '```text\nthoughts = observations + questions + time\n\nnotes = keep(thoughts)\n```\n\n普通文字与 `inline`。';
  await setBody(fencedBody);
  await checkCodeBackgrounds(5);
  assert.notEqual(
    await page
      .locator('.CodeMirror-code .cm-comment')
      .last()
      .evaluate((element) => getComputedStyle(element).backgroundColor),
    'rgba(0, 0, 0, 0)',
    'Inline code must retain its separate styling',
  );
  // Removing a closing fence must immediately extend the block through blank lines.
  await page.locator('.CodeMirror').evaluate((element) => {
    element.CodeMirror.setSelection({ line: 4, ch: 0 }, { line: 4, ch: 3 });
    element.CodeMirror.focus();
  });
  await page.keyboard.press('Backspace');
  await checkCodeBackgrounds(7);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await checkCodeBackgrounds(5);
  await expect(page.locator('#post-body')).toHaveValue(fencedBody);
  await setBody('~~~text\n代码正文\n~~~');
  await checkCodeBackgrounds(3);
  await setBody('普通段落与 `inline`。');
  await expect(codeBackgrounds).toHaveCount(0);
  await markdownInput.focus();
  await page.keyboard.press('Tab');
  assert.equal(
    await page.evaluate(() =>
      Boolean(document.activeElement.closest('.CodeMirror')),
    ),
    false,
    'Tab must leave the editor',
  );
  await page.getByRole('button', { name: '二级标题', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(
    page.getByRole('button', { name: '加粗', exact: true }),
  ).toBeFocused();
  await setBody(
    '## 浏览器预览\n\n**粗体文字**\n\n```js\nconst answer = 42;\n```\n\n<script>parent.document.body.remove()</script>',
  );
  await page.getByRole('button', { name: '预览', exact: true }).click();
  await expect(
    page
      .frameLocator('#preview-frame')
      .getByRole('heading', { name: '浏览器预览' }),
  ).toBeVisible();
  await expect(page.locator('#workspace')).toBeVisible();
  await page
    .locator('#editor-upload')
    .setInputFiles({ name: 'check.png', mimeType: 'image/png', buffer: png });
  await expect(page.locator('#post-body')).toHaveValue(/\/images\/.+\.png/);
  await expect(
    page.frameLocator('#preview-frame').locator('img'),
  ).toBeVisible();
  await markdownInput.evaluate((element, base64) => {
    const transfer = new DataTransfer();
    transfer.items.add(
      new File(
        [Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))],
        'pasted.png',
        { type: 'image/png' },
      ),
    );
    element.dispatchEvent(
      new ClipboardEvent('paste', {
        clipboardData: transfer,
        bubbles: true,
        cancelable: true,
      }),
    );
  }, png.toString('base64'));
  await expect(page.frameLocator('#preview-frame').locator('img')).toHaveCount(
    2,
  );
  await expect(page.locator('#editor-count')).toContainText('字符');
  await page.getByRole('button', { name: '保存文章', exact: true }).click();
  await expect(page.locator('#save-status')).toContainText('已保存');
  assert.match(
    await readFile(
      path.join(ctx.dir, 'src/content/notes/browser-check.md'),
      'utf8',
    ),
    /draft: true/,
  );
  await page.screenshot({
    path: path.join(screenshots, 'admin-editor.png'),
    fullPage: true,
  });
  await page.locator('#post-form [name=title]').fill('尚未保存的内容');
  await page.getByRole('button', { name: '← 返回文章' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.locator('#post-form [name=title]')).toHaveValue(
    '尚未保存的内容',
  );
  await page.locator('#post-form [name=title]').fill('浏览器验证文章');
  // Raw HTML was used to verify preview isolation, then removed before publication.
  await setBody(
    '## 已发布正文\n\n浏览器发布检索词\n\n```js\nconst answer = 42;\n```',
  );
  await page.locator('#post-form [name=state]').selectOption('ready');
  await page.getByRole('button', { name: '保存文章', exact: true }).click();
  await expect(page.locator('#save-status')).toContainText('已保存');
  await page.locator('.admin-sidebar [data-view=settings]').click();
  const description = '计算机与数学，记录日常想法。';
  const aboutBody =
    '## 关于稀疏札记\n\n记录 **学习过程** 和做项目时的思考。\n\n[阅读文章](/archive/)';
  const aboutInput = page.locator(
    '#settings-form .CodeMirror [contenteditable=true]',
  );
  await expect(page.locator('#settings-description')).toHaveValue(
    '计算机、数学，与一些随想。',
  );
  await page.locator('#settings-description').fill(description);
  await aboutInput.focus();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.insertText(aboutBody);
  await expect(page.locator('#settings-about')).toHaveValue(aboutBody);
  await page.locator('#settings-toggle-preview').click();
  await expect(
    page
      .frameLocator('#settings-preview-frame')
      .getByRole('heading', { name: '关于稀疏札记' }),
  ).toBeVisible();
  await expect(
    page.frameLocator('#settings-preview-frame').locator('strong'),
  ).toHaveText('学习过程');
  await page.locator('#settings-upload').setInputFiles({
    name: 'about.png',
    mimeType: 'image/png',
    buffer: png,
  });
  await expect(
    page.frameLocator('#settings-preview-frame').locator('img'),
  ).toBeVisible();
  await aboutInput.focus();
  await page.keyboard.press('ControlOrMeta+S');
  await expect(page.locator('#settings-save-status')).toContainText('已保存');
  const savedAbout = await page.locator('#settings-about').inputValue();
  const savedSettings = JSON.parse(
    await readFile(path.join(ctx.dir, 'src/data/settings/site.json'), 'utf8'),
  );
  assert.deepEqual(savedSettings, { description, about: savedAbout });
  await page.screenshot({
    path: path.join(screenshots, 'admin-settings-desktop.png'),
    fullPage: true,
  });
  await page.locator('#settings-description').fill('尚未保存的网站介绍');
  await page.locator('.admin-sidebar [data-view=posts]').click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.locator('#settings-description')).toHaveValue(
    '尚未保存的网站介绍',
  );
  await page.locator('.admin-sidebar [data-view=posts]').click();
  await page.getByRole('button', { name: '放弃修改', exact: true }).click();
  await page.reload();
  await page.locator('.admin-sidebar [data-view=settings]').click();
  await expect(page.locator('#settings-description')).toHaveValue(description);
  await expect(page.locator('#settings-about')).toHaveValue(savedAbout);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#settings-toggle-preview').click();
  await expect(
    page
      .frameLocator('#settings-preview-frame')
      .getByRole('heading', { name: '关于稀疏札记' }),
  ).toBeVisible();
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
    'Mobile website settings overflow',
  );
  await page.screenshot({
    path: path.join(screenshots, 'admin-settings-mobile.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator('.admin-sidebar [data-view=publish]').click();
  await page.getByRole('button', { name: '构建并发布', exact: true }).click();
  await page.getByRole('button', { name: '开始发布', exact: true }).click();
  await expect(page.locator('#build-history')).toContainText('成功', {
    timeout: 60000,
  });
  await page.screenshot({
    path: path.join(screenshots, 'admin-publish.png'),
    fullPage: true,
  });
  const publicPage = await context.newPage();
  publicPage.setDefaultTimeout(15000);
  await publicPage.goto(`${ctx.app.origin}/`);
  assert.equal(
    (await publicPage.locator('.sidebar-intro').textContent()).replace(
      /\s/g,
      '',
    ),
    description,
  );
  await expect(publicPage.locator('meta[name=description]')).toHaveAttribute(
    'content',
    description,
  );
  await expect(publicPage.locator('.footer-meta')).toContainText(
    `©${new Date().getFullYear()} 稀疏札记`,
  );
  await publicPage.getByRole('link', { name: '关于', exact: true }).click();
  await expect(
    publicPage.getByRole('heading', { name: '关于稀疏札记' }),
  ).toBeVisible();
  await expect(publicPage.locator('.prose strong')).toHaveText('学习过程');
  await expect(publicPage.locator('.prose img')).toBeVisible();
  await expect(publicPage.locator('body')).not.toContainText(
    '标注“示例”的文章用于展示排版，不计入 RSS 订阅。',
  );
  await publicPage.screenshot({
    path: path.join(screenshots, 'blog-about-desktop.png'),
    fullPage: true,
  });
  await publicPage.getByRole('link', { name: '归档', exact: true }).click();
  await publicPage
    .getByRole('link', { name: '浏览器验证文章', exact: true })
    .click();
  await expect(
    publicPage.getByRole('heading', { name: '已发布正文' }),
  ).toBeVisible();
  const contrast = await publicPage.locator('pre').evaluate((element) => ({
    background: getComputedStyle(element).backgroundColor,
    color: getComputedStyle(element.querySelector('span[style]')).color,
  }));
  assert.equal(contrast.background, 'rgb(245, 245, 245)');
  assert.notEqual(contrast.color, 'rgb(255, 255, 255)');
  await publicPage.getByRole('link', { name: '归档', exact: true }).click();
  await publicPage.locator('#search-input').fill('浏览器发布检索词');
  await expect(
    publicPage.getByRole('link', { name: '浏览器验证文章', exact: true }),
  ).toBeVisible();
  await publicPage.screenshot({
    path: path.join(screenshots, 'blog-desktop.png'),
    fullPage: true,
  });
  await page.locator('.admin-sidebar [data-view=posts]').click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: path.join(screenshots, 'admin-mobile.png'),
    fullPage: true,
  });
  const overflow = async (surface) =>
    surface.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  assert.equal(await overflow(page), false, 'Mobile article list overflows');
  await page
    .getByRole('button', { name: '浏览器验证文章', exact: true })
    .click();
  await expect(page.locator('#post-form')).toBeVisible();
  assert.equal(await overflow(page), false, 'Mobile editor overflows');
  await page.getByRole('button', { name: '预览', exact: true }).click();
  await expect(
    page
      .frameLocator('#preview-frame')
      .getByRole('heading', { name: '已发布正文' }),
  ).toBeVisible();
  assert.equal(await overflow(page), false, 'Mobile preview overflows');
  await page.screenshot({
    path: path.join(screenshots, 'admin-editor-mobile.png'),
    fullPage: true,
  });
  await page.getByRole('button', { name: '移入回收站', exact: true }).click();
  await page.locator('#confirm-accept').click();
  await expect(page.locator('#notice')).toContainText('已移入回收站');
  await page.locator('.admin-sidebar [data-view=trash]').click();
  await page.getByRole('button', { name: '恢复', exact: true }).click();
  await expect(page.locator('#notice')).toContainText('已恢复');
  await page.locator('.admin-sidebar [data-view=media]').click();
  await expect(page.locator('.admin-media-item')).toHaveCount(3);
  assert.equal(await overflow(page), false, 'Mobile media library overflows');
  await page.locator('.admin-sidebar [data-view=account]').click();
  await page
    .locator('#password-form [name=currentPassword]')
    .fill('browser-check-password');
  await page
    .locator('#password-form [name=password]')
    .fill('changed-browser-password');
  await page
    .locator('#password-form [name=confirm]')
    .fill('changed-browser-password');
  await page.getByRole('button', { name: '更新密码', exact: true }).click();
  await expect(page.locator('#notice')).toContainText('密码已更新');
  await page.getByRole('button', { name: '退出', exact: true }).click();
  await expect(page.getByRole('heading', { name: '登录后台' })).toBeVisible();
  await page
    .locator('#auth-form [name=password]')
    .fill('changed-browser-password');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('#workspace')).toBeVisible();
  await page.locator('#new-post').focus();
  await page.keyboard.press('Tab');
  assert.equal(
    await page.evaluate(
      () => getComputedStyle(document.activeElement).outlineStyle,
    ),
    'solid',
  );
  await publicPage.setViewportSize({ width: 390, height: 844 });
  await publicPage.goto(`${ctx.app.origin}/notes/browser-check/`);
  assert.equal(
    await overflow(publicPage),
    false,
    'Mobile public article overflows',
  );
  await publicPage.screenshot({
    path: path.join(screenshots, 'blog-mobile.png'),
    fullPage: true,
  });
  await publicPage.getByRole('link', { name: '关于', exact: true }).click();
  assert.equal(
    await overflow(publicPage),
    false,
    'Mobile About page overflows',
  );
  await expect(publicPage.locator('.footer-meta')).toContainText(
    `©${new Date().getFullYear()} 稀疏札记`,
  );
  await publicPage.screenshot({
    path: path.join(screenshots, 'blog-about-mobile.png'),
    fullPage: true,
  });
  const noJs = await browser.newContext({ javaScriptEnabled: false });
  const readable = await noJs.newPage();
  await readable.goto(`${ctx.app.origin}/archive/`);
  await expect(
    readable.getByRole('link', { name: '浏览器验证文章', exact: true }),
  ).toBeVisible();
  await expect(readable.locator('#archive-search')).toBeHidden();
  await noJs.close();
  assert.deepEqual(errors, []);
  assert.deepEqual(
    externalRequests,
    [],
    'Editor must not fetch fonts, dictionaries or scripts from a CDN',
  );
  console.log(
    'Browser checks passed: setup/login, search, Markdown editor, sandboxed preview, upload, unsaved edits, website settings, About page, footer, save, publication, public search/navigation, trash/restore, password/logout, keyboard focus, no-JS public navigation and 390px layouts.',
  );
  console.log(`Screenshots: ${screenshots}`);
} finally {
  if (browser) await browser.close();
  await ctx.close();
}
