export {};

const $ = (selector) => document.querySelector(selector);
const all = (selector) => [...document.querySelectorAll(selector)];
const escape = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        char
      ],
  );
const state = {
  csrf: '',
  posts: [],
  publication: null,
  post: null,
  view: 'posts',
  dirty: false,
  preview: false,
  setup: false,
  poll: null,
  logId: null,
  saving: false,
  uploading: 0,
  settings: null,
  settingsDirty: false,
  settingsSaving: false,
  settingsUploading: 0,
  settingsPreview: false,
};
const setupToken =
  new URLSearchParams(location.hash.slice(1)).get('setup') || '';
if (setupToken) history.replaceState(null, '', location.pathname);
const form = $('#post-form');
const field = (name) => form.elements.namedItem(name);
let markdownEditor;
let loadingEditor = false;
let editorGeneration = 0;
const settingsForm = $('#settings-form');
const settingsField = (name) => settingsForm.elements.namedItem(name);
let settingsEditor;
let loadingSettings = false;
let settingsGeneration = 0;
let settingsPreviewSequence = 0;
let settingsPreviewTimer;

function styleCodeBlocks(cm) {
  const CodeMirror = cm.constructor;
  CodeMirror.defineMode('admin-markdown', (config, options) => {
    const mode = CodeMirror.getMode(config, { ...options, name: 'gfm' });
    const codeStyle = (style, state) => {
      // Follow the Markdown parser so blank lines and edits to fences stay in sync.
      const markdown = state.base;
      return markdown.fencedEndRE ||
        markdown.indentedCode ||
        /\bformatting-code-block\b/.test(style || '')
        ? `${style || ''} line-admin-code-line line-background-admin-code-background`
        : style;
    };
    return {
      ...mode,
      token(stream, state) {
        return codeStyle(mode.token(stream, state), state);
      },
      blankLine(state) {
        return codeStyle(mode.blankLine(state), state);
      },
    };
  });
  cm.setOption('mode', { ...cm.getOption('mode'), name: 'admin-markdown' });
}

function createMarkdownEditor(
  element,
  { label, countId, onChange, onImages, isSaving },
) {
  const MDE = window.EasyMDE;
  if (!MDE) {
    notice('编辑器未能加载，暂时使用文本输入。刷新页面可重试。', true);
    return null;
  }
  const button = (name, text, title, command) => ({
    name,
    text,
    title,
    action: command,
  });
  const editor = new MDE({
    element,
    autoDownloadFontAwesome: false,
    spellChecker: false,
    nativeSpellcheck: false,
    autosave: { enabled: false },
    forceSync: true,
    inputStyle: 'contenteditable',
    indentWithTabs: false,
    minHeight: '420px',
    maxHeight: '65vh',
    status: false,
    promptURLs: true,
    promptTexts: { link: '输入链接地址（https://…）：' },
    shortcuts: {
      togglePreview: null,
      toggleSideBySide: null,
      toggleFullScreen: null,
      drawImage: null,
    },
    insertTexts: {
      table: ['', '\n\n| 列名 | 列名 |\n| --- | --- |\n| 内容 | 内容 |\n\n'],
    },
    toolbar: [
      button('heading-2', '标题', '二级标题', MDE.toggleHeading2),
      button('bold', '加粗', '加粗', MDE.toggleBold),
      button('italic', '斜体', '斜体', MDE.toggleItalic),
      button('quote', '引用', '引用', MDE.toggleBlockquote),
      '|',
      button('unordered-list', '列表', '无序列表', MDE.toggleUnorderedList),
      button('ordered-list', '编号', '有序列表', MDE.toggleOrderedList),
      button('link', '链接', '插入链接', MDE.drawLink),
      button('code', '代码', '代码', MDE.toggleCodeBlock),
      button('table', '表格', '插入表格', MDE.drawTable),
      '|',
      button('undo', '撤销', '撤销', MDE.undo),
      button('redo', '重做', '重做', MDE.redo),
    ],
  });
  const cm = editor.codemirror;
  styleCodeBlocks(cm);
  cm.setOption('screenReaderLabel', label);
  // Tab moves to the next control instead of trapping keyboard users in the editor.
  cm.setOption('extraKeys', {
    ...cm.getOption('extraKeys'),
    Tab: false,
    'Shift-Tab': false,
  });
  cm.getInputField().setAttribute('aria-describedby', countId);
  const container = cm.getWrapperElement().closest('.EasyMDEContainer');
  container.setAttribute('role', 'group');
  container.setAttribute('aria-label', 'Markdown 编辑器');
  const toolbar = container.querySelector('[role=toolbar]');
  toolbar.setAttribute('aria-label', 'Markdown 格式');
  const buttons = [...toolbar.querySelectorAll('button')];
  buttons[0].tabIndex = 0;
  toolbar.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const index = buttons.indexOf(document.activeElement);
    if (index < 0) return;
    event.preventDefault();
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? buttons.length - 1
          : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) %
            buttons.length;
    buttons.forEach((item, position) => {
      item.tabIndex = position === next ? 0 : -1;
    });
    buttons[next].focus();
  });
  cm.on('change', onChange);
  const receiveImages = (event, files) => {
    const images = [...(files || [])].filter((item) =>
      /^image\//.test(item.type),
    );
    if (!images.length) return;
    event.preventDefault();
    if (event.type === 'drop')
      cm.setCursor(
        cm.coordsChar({ left: event.clientX, top: event.clientY }, 'window'),
      );
    if (isSaving()) return;
    onImages(images).catch((error) => notice(error.message, true));
  };
  cm.on('paste', (_cm, event) =>
    receiveImages(event, event.clipboardData?.files),
  );
  cm.on('drop', (_cm, event) =>
    receiveImages(event, event.dataTransfer?.files),
  );
  return editor;
}

function ensureMarkdownEditor() {
  markdownEditor ||= createMarkdownEditor(field('body'), {
    label: 'Markdown 正文',
    countId: 'editor-count',
    onChange() {
      updateEditorCount();
      if (!loadingEditor) contentChanged();
    },
    onImages: (images) =>
      Promise.all(images.map((image) => insertImage(image))),
    isSaving: () => state.saving,
  });
  return markdownEditor;
}

function updateEditorCount() {
  $('#editor-count').textContent =
    `${Array.from(field('body').value).length.toLocaleString('zh-CN')} 字符`;
}
const dateLabel = (value) =>
  value
    ? new Date(value).toLocaleString('zh-CN', { hour12: false })
    : '尚未发布';
const inputDate = (value) =>
  value?.endsWith('T00:00:00.000Z') ? value.slice(0, 10) : value || '';

function notice(message, error = false) {
  $('#notice').textContent = message;
  $('#notice').hidden = !message;
  $('#notice').classList.toggle('is-error', error);
  $('#notice').setAttribute('role', error ? 'alert' : 'status');
}
async function api(route, options = {}) {
  const headers = { ...options.headers };
  if (options.method && options.method !== 'GET') {
    headers['X-CSRF-Token'] = state.csrf;
    if (!(options.body instanceof File))
      headers['Content-Type'] = 'application/json';
  }
  const response = await fetch(`/admin/api/${route}`, {
    ...options,
    headers,
    credentials: 'same-origin',
    cache: 'no-store',
  });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401 && !['login', 'setup'].includes(route))
      showAuth(false);
    throw new Error(data.error || `请求失败（${response.status}）`);
  }
  return data;
}
function action(handler) {
  return async (event) => {
    const button =
      event?.currentTarget instanceof HTMLButtonElement
        ? event.currentTarget
        : null;
    if (button?.disabled) return;
    if (button) button.disabled = true;
    try {
      await handler(event);
    } catch (error) {
      notice(error.message || '操作失败，请重试。', true);
    } finally {
      if (button)
        button.disabled =
          button.id === 'publish-button' && Boolean(state.publication?.busy);
    }
  };
}
function confirmAction(title, description, label = '确认') {
  const dialog = $('#confirm-dialog');
  $('#confirm-title').textContent = title;
  $('#confirm-description').textContent = description;
  $('#confirm-accept').textContent = label;
  dialog.returnValue = '';
  dialog.showModal();
  return new Promise((resolve) =>
    dialog.addEventListener(
      'close',
      () => resolve(dialog.returnValue === 'confirm'),
      { once: true },
    ),
  );
}
function dirty(value = true) {
  state.dirty = value;
  $('#save-status').textContent = value
    ? '有未保存的修改'
    : state.post
      ? '已保存。重新发布后会更新公开网站。'
      : '保存为草稿后可继续编辑。';
}
function showAuth(setup) {
  state.setup = setup;
  $('#auth-panel').hidden = false;
  $('#workspace').hidden = true;
  $('#logout').hidden = true;
  $('#auth-title').textContent = setup ? '创建管理员' : '登录后台';
  $('#auth-description').textContent = setup
    ? '设置账号和密码，开始管理你的网站。'
    : '管理文章、图片与网站发布。';
  $('#auth-submit').textContent = setup ? '创建并登录' : '登录';
  $('#setup-token-label').hidden = !setup || Boolean(setupToken);
  $('#setup-confirm-label').hidden = !setup;
  const authForm = $('#auth-form');
  authForm.elements.token.value = setupToken;
  authForm.elements.password.minLength = setup ? 12 : 1;
  authForm.elements.password.autocomplete = setup
    ? 'new-password'
    : 'current-password';
  authForm.elements.confirm.required = setup;
  $('#auth-help').textContent = setup
    ? '密码至少 12 个字符。初始化链接仅在创建账号前有效。'
    : '仅供网站管理员使用。';
  clearTimeout(state.poll);
}
async function showWorkspace(session) {
  state.csrf = session.csrf;
  $('#account-name').textContent = `当前账号：${session.username}`;
  $('#auth-panel').hidden = true;
  $('#workspace').hidden = false;
  $('#logout').hidden = false;
  await refresh();
  await navigate(state.view, false);
}
async function refresh() {
  [state.posts, state.publication] = await Promise.all([
    api('posts'),
    api('publication'),
  ]);
  $('#post-count').textContent = state.posts.length;
  $('#categories').innerHTML = [
    ...new Set(state.posts.map((post) => post.category)),
  ]
    .map((category) => `<option value="${escape(category)}"></option>`)
    .join('');
  renderPosts();
  renderPublication();
}
function postStatus(post) {
  if (post.draft) return { key: 'draft', label: '草稿' };
  if (Date.parse(post.date) > Date.now())
    return { key: 'scheduled', label: '未来日期' };
  if (state.publication?.manifest[post.slug] === post.revision)
    return { key: 'live', label: '已发布' };
  return {
    key: 'ready',
    label: state.publication?.manifest[post.slug] ? '有修改' : '待发布',
  };
}
function renderPosts() {
  const query = $('#post-search').value.trim().toLocaleLowerCase();
  const filter = $('#post-filter').value;
  const posts = state.posts.filter((post) => {
    if (
      query &&
      !`${post.title} ${post.category} ${post.body} ${post.slug}`
        .toLocaleLowerCase()
        .includes(query)
    )
      return false;
    if (filter === 'example') return post.example;
    if (filter === 'ready')
      return !post.draft && Date.parse(post.date) <= Date.now();
    return filter === 'all' || postStatus(post).key === filter;
  });
  $('#list-summary').textContent =
    `${posts.length} 篇文章${filter === 'all' && !query ? ' · 保存的修改在构建发布后生效' : ''}`;
  $('#post-list').innerHTML = posts.length
    ? posts
        .map((post) => {
          const status = postStatus(post);
          return `<article class="admin-post-row"><div><button type="button" class="admin-post-title" data-edit="${escape(post.slug)}">${escape(post.title)}</button><p class="admin-row-meta"><time>${escape(post.date.slice(0, 10))}</time><span>${escape(post.category)}</span>${post.example ? '<span class="admin-example">示例</span>' : ''}<span class="admin-slug">/${escape(post.slug)}/</span></p></div><span class="admin-badge ${status.key}">${status.label}</span></article>`;
        })
        .join('')
    : `<div class="admin-empty"><h2>${query || filter !== 'all' ? '没有符合条件的文章' : '还没有文章'}</h2><p>${query || filter !== 'all' ? '试试其他关键词或文章状态。' : '新建一篇文章，从草稿开始。'}</p></div>`;
}
async function navigate(view, guard = true) {
  if (guard && (state.saving || state.settingsSaving)) {
    notice('正在保存，请稍候。');
    return false;
  }
  if (guard && view === 'settings' && state.view === 'settings') return true;
  if (
    guard &&
    ((state.view === 'editor' && state.dirty) ||
      (state.view === 'settings' && state.settingsDirty)) &&
    !(await confirmAction(
      '离开编辑？',
      '当前修改尚未保存。离开后，这些修改会丢失。',
      '放弃修改',
    ))
  )
    return false;
  if (state.view === 'editor' && view !== 'editor' && guard) dirty(false);
  if (state.view === 'settings' && view !== 'settings' && guard)
    settingsDirty(false);
  state.view = view;
  all('[data-panel]').forEach((panel) => {
    panel.hidden = panel.dataset.panel !== view;
  });
  all('.admin-sidebar [data-view]').forEach((button) => {
    if (button.dataset.view === (view === 'editor' ? 'posts' : view))
      button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  document.title = `${{ posts: '文章', editor: '编辑文章', settings: '网站设置', media: '图片', publish: '发布', trash: '回收站', account: '账号' }[view]} · sparsity.tech`;
  if (view === 'media') await loadMedia();
  if (view === 'trash') await loadTrash();
  if (view === 'settings') await loadSettings();
  if (view === 'publish') {
    state.publication = await api('publication');
    renderPublication();
  }
  if (guard) {
    notice('');
    $('#admin-main').focus();
  }
  return true;
}

function settingsDirty(value = true) {
  state.settingsDirty = value;
  $('#settings-save-status').textContent = value
    ? '有未保存的修改'
    : '已保存。重新发布后会更新公开网站。';
}
function updateSettingsCount() {
  $('#settings-count').textContent =
    `${Array.from(settingsField('about').value).length.toLocaleString('zh-CN')} 字符`;
}
async function loadSettings() {
  const settings = await api('settings');
  settingsGeneration++;
  state.settings = settings;
  settingsField('description').value = settings.description;
  loadingSettings = true;
  try {
    settingsField('about').value = settings.about;
    settingsEditor ||= createMarkdownEditor(settingsField('about'), {
      label: '关于正文',
      countId: 'settings-count',
      onChange() {
        updateSettingsCount();
        if (!loadingSettings) settingsChanged();
      },
      onImages: (images) =>
        Promise.all(images.map((image) => insertImage(image, 'settings'))),
      isSaving: () => state.settingsSaving,
    });
    settingsEditor?.value(settings.about);
    settingsEditor?.codemirror.clearHistory();
  } finally {
    loadingSettings = false;
  }
  settingsPreviewSequence++;
  clearTimeout(settingsPreviewTimer);
  state.settingsPreview = false;
  $('#settings-preview-frame').hidden = true;
  $('#settings-preview-frame').srcdoc = '';
  $('#settings-editor-panes').classList.remove('has-preview');
  $('#settings-toggle-preview').setAttribute('aria-pressed', 'false');
  $('#settings-toggle-preview').textContent = '预览';
  updateSettingsCount();
  settingsDirty(false);
  requestAnimationFrame(() => settingsEditor?.codemirror.refresh());
}
async function saveSettings(event) {
  event?.preventDefault();
  if (state.settingsSaving || !settingsForm.reportValidity()) return;
  if (!state.settings) throw new Error('网站设置尚未加载，请重新打开。');
  if (state.settingsUploading) {
    notice('图片正在上传，请完成后再保存。');
    return;
  }
  const data = {
    description: settingsField('description').value,
    about: settingsField('about').value,
    revision: state.settings.revision,
  };
  const disabled = [...settingsForm.elements].map((element) => [
    element,
    element.disabled,
  ]);
  state.settingsSaving = true;
  for (const [element] of disabled) element.disabled = true;
  settingsEditor?.codemirror.setOption('readOnly', true);
  try {
    state.settings = await api('settings', {
      method: 'PUT',
      body: JSON.stringify(data),
    });
    settingsField('description').value = state.settings.description;
    settingsDirty(false);
    notice('网站设置已保存。前往「发布」即可更新网站介绍和关于页面。');
    await refresh();
  } finally {
    for (const [element, wasDisabled] of disabled)
      element.disabled = wasDisabled;
    state.settingsSaving = false;
    settingsEditor?.codemirror.setOption('readOnly', false);
  }
}
async function previewSettings() {
  const sequence = ++settingsPreviewSequence;
  const result = await api('preview', {
    method: 'POST',
    body: JSON.stringify({ title: '关于', body: settingsField('about').value }),
  });
  if (sequence !== settingsPreviewSequence || !state.settingsPreview) return;
  $('#settings-preview-frame').srcdoc = result.html;
}
function settingsChanged() {
  settingsDirty();
  updateSettingsCount();
  if (state.settingsPreview) {
    clearTimeout(settingsPreviewTimer);
    settingsPreviewTimer = setTimeout(
      () => previewSettings().catch((error) => notice(error.message, true)),
      600,
    );
  }
}
settingsForm.addEventListener('input', (event) => {
  if (!event.target.closest('.CodeMirror')) settingsChanged();
});
settingsForm.addEventListener('submit', action(saveSettings));
$('#settings-toggle-preview').addEventListener(
  'click',
  action(async () => {
    state.settingsPreview = !state.settingsPreview;
    $('#settings-preview-frame').hidden = !state.settingsPreview;
    $('#settings-editor-panes').classList.toggle(
      'has-preview',
      state.settingsPreview,
    );
    $('#settings-toggle-preview').setAttribute(
      'aria-pressed',
      String(state.settingsPreview),
    );
    $('#settings-toggle-preview').textContent = state.settingsPreview
      ? '收起预览'
      : '预览';
    requestAnimationFrame(() => settingsEditor?.codemirror.refresh());
    if (state.settingsPreview) await previewSettings();
  }),
);

function fillEditor(post) {
  editorGeneration++;
  state.post = post;
  form.reset();
  for (const key of ['title', 'slug', 'category', 'description', 'body'])
    field(key).value = post?.[key] || '';
  loadingEditor = true;
  try {
    const editor = ensureMarkdownEditor();
    editor?.value(post?.body || '');
    editor?.codemirror.clearHistory();
  } finally {
    loadingEditor = false;
  }
  updateEditorCount();
  field('date').value = post
    ? inputDate(post.date)
    : new Date().toISOString().slice(0, 10);
  field('updated').value = inputDate(post?.updated);
  field('state').value = post && !post.draft ? 'ready' : 'draft';
  field('example').checked = Boolean(post?.example);
  field('excerpt').value = post?.excerpt?.join('\n\n') || '';
  field('slug').disabled = Boolean(post);
  if (post?.slug.includes('/')) field('slug').removeAttribute('pattern');
  else field('slug').pattern = '[a-z0-9]+(-[a-z0-9]+)*';
  $('#editor-heading').textContent = post ? '编辑文章' : '新建文章';
  $('#trash-post').hidden = !post;
  state.preview = false;
  $('#preview-frame').hidden = true;
  $('#preview-frame').srcdoc = '';
  $('#editor-panes').classList.remove('has-preview');
  $('#toggle-preview').setAttribute('aria-pressed', 'false');
  $('#toggle-preview').textContent = '预览';
  dirty(false);
  requestAnimationFrame(() => markdownEditor?.codemirror.refresh());
}
async function edit(slug) {
  if (!(await navigate('editor'))) return;
  const post = slug ? await api(`posts/${encodeURIComponent(slug)}`) : null;
  fillEditor(post);
  field('title').focus();
}
function postData() {
  return {
    slug: field('slug').value.trim(),
    title: field('title').value,
    category: field('category').value,
    description: field('description').value,
    body: field('body').value,
    date: field('date').value.trim(),
    updated: field('updated').value.trim() || undefined,
    draft: field('state').value === 'draft',
    example: field('example').checked,
    excerpt: field('excerpt').value.trim()
      ? field('excerpt')
          .value.trim()
          .split(/\n\s*\n/)
      : undefined,
    revision: state.post?.revision,
  };
}
async function save(event) {
  event?.preventDefault();
  if (state.saving || !form.reportValidity()) return;
  if (state.uploading) {
    notice('图片正在上传，请完成后再保存。');
    return;
  }
  state.saving = true;
  $('#save-post').disabled = true;
  // Prevent edits while the saved response is being reconciled with the form.
  const disabled = [...form.elements].map((element) => [
    element,
    element.disabled,
  ]);
  const data = postData();
  for (const [element] of disabled) element.disabled = true;
  markdownEditor?.codemirror.setOption('readOnly', true);
  try {
    const post = await api(
      state.post ? `posts/${encodeURIComponent(state.post.slug)}` : 'posts',
      { method: state.post ? 'PUT' : 'POST', body: JSON.stringify(data) },
    );
    state.post = post;
    dirty(false);
    $('#editor-heading').textContent = '编辑文章';
    $('#trash-post').hidden = false;
    notice('文章已保存。需要更新公开网站时，请前往「发布」。');
    await refresh();
  } finally {
    for (const [element, wasDisabled] of disabled)
      element.disabled = wasDisabled;
    field('slug').disabled = Boolean(state.post);
    state.saving = false;
    markdownEditor?.codemirror.setOption('readOnly', false);
    $('#save-post').disabled = false;
  }
}
let previewSequence = 0;
async function preview() {
  const sequence = ++previewSequence;
  const result = await api('preview', {
    method: 'POST',
    body: JSON.stringify({
      title: field('title').value,
      body: field('body').value,
    }),
  });
  if (sequence !== previewSequence || !state.preview) return;
  $('#preview-frame').srcdoc = result.html;
}
let previewTimer;
function contentChanged() {
  dirty();
  updateEditorCount();
  if (state.preview) {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(
      () => preview().catch((error) => notice(error.message, true)),
      600,
    );
  }
}
form.addEventListener('input', (event) => {
  if (!event.target.closest('.CodeMirror')) contentChanged();
});
form.addEventListener('submit', action(save));
$('#toggle-preview').addEventListener(
  'click',
  action(async () => {
    state.preview = !state.preview;
    $('#preview-frame').hidden = !state.preview;
    $('#editor-panes').classList.toggle('has-preview', state.preview);
    $('#toggle-preview').setAttribute('aria-pressed', String(state.preview));
    $('#toggle-preview').textContent = state.preview ? '收起预览' : '预览';
    requestAnimationFrame(() => markdownEditor?.codemirror.refresh());
    if (state.preview) await preview();
  }),
);
$('#new-post').addEventListener(
  'click',
  action(() => edit()),
);
$('#post-list').addEventListener(
  'click',
  action((event) => {
    const button = event.target.closest('[data-edit]');
    if (button) return edit(button.dataset.edit);
  }),
);
$('#post-search').addEventListener('input', renderPosts);
$('#post-filter').addEventListener('change', renderPosts);
all('[data-view]').forEach((button) =>
  button.addEventListener(
    'click',
    action(() => navigate(button.dataset.view)),
  ),
);
$('#trash-post').addEventListener(
  'click',
  action(async () => {
    if (
      !(await confirmAction(
        '移入回收站？',
        `「${state.post.title}」可从回收站恢复。${state.dirty ? '当前未保存的修改会丢失。' : ''}重新发布后，公开网站才会移除这篇文章。`,
        '移入回收站',
      ))
    )
      return;
    await api(`posts/${encodeURIComponent(state.post.slug)}`, {
      method: 'DELETE',
      body: JSON.stringify({ revision: state.post.revision }),
    });
    dirty(false);
    await refresh();
    await navigate('posts');
    notice('文章已移入回收站。');
  }),
);
async function loadTrash() {
  const items = await api('trash');
  $('#trash-list').innerHTML = items.length
    ? items
        .map(
          (item) =>
            `<article class="admin-post-row"><div><h2>${escape(item.title)}</h2><p class="admin-row-meta">${escape(dateLabel(item.deletedAt))} · /${escape(item.slug)}/</p></div><button type="button" class="admin-button" data-restore="${escape(item.id)}">恢复</button></article>`,
        )
        .join('')
    : '<div class="admin-empty"><h2>回收站是空的</h2><p>移除的文章会保留在这里。</p></div>';
}
$('#trash-list').addEventListener(
  'click',
  action(async (event) => {
    const button = event.target.closest('[data-restore]');
    if (!button) return;
    await api('restore', {
      method: 'POST',
      body: JSON.stringify({ id: button.dataset.restore }),
    });
    await Promise.all([loadTrash(), refresh()]);
    notice('文章已恢复，原有状态保持不变。');
  }),
);
async function uploadImage(image) {
  if (image.size > 8 * 1024 * 1024) throw new Error('图片不能超过 8 MB。');
  if (
    !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(image.type)
  )
    throw new Error('仅支持 PNG、JPEG、GIF、WebP 图片。');
  return api('media', {
    method: 'POST',
    body: image,
    headers: { 'Content-Type': 'application/octet-stream' },
  });
}
async function insertImage(image, target = 'editor') {
  const isSettings = target === 'settings';
  const generation = isSettings ? settingsGeneration : editorGeneration;
  const cm = (isSettings ? settingsEditor : markdownEditor)?.codemirror;
  const uploading = isSettings ? 'settingsUploading' : 'uploading';
  const position = cm
    ?.getDoc()
    .setBookmark(cm.getCursor(), { insertLeft: true });
  state[uploading]++;
  try {
    const media = await uploadImage(image);
    if (
      generation !== (isSettings ? settingsGeneration : editorGeneration) ||
      state.view !== target
    ) {
      notice('图片已上传到图片库，可稍后插入正文。');
      return;
    }
    const text = `\n![图片说明](${media.url})\n`;
    if (cm && position?.find())
      cm.replaceRange(text, position.find(), position.find(), '+input');
    else {
      const body = isSettings ? settingsField('about') : field('body');
      body.setRangeText(text, body.selectionStart, body.selectionEnd, 'end');
      if (isSettings) settingsChanged();
      else contentChanged();
    }
    cm?.focus();
    await refresh();
    if (isSettings && state.settingsPreview) await previewSettings();
    if (!isSettings && state.preview) await preview();
    notice('图片已插入正文，请补充图片说明并保存。');
  } finally {
    position?.clear();
    state[uploading]--;
  }
}
async function upload(input, insert) {
  const image = input.files[0];
  if (!image) return;
  input.disabled = true;
  try {
    if (insert)
      await insertImage(image, insert === 'settings' ? 'settings' : 'editor');
    else {
      await uploadImage(image);
      await loadMedia();
      await refresh();
      notice('图片已上传，可复制 Markdown 链接插入文章。');
    }
  } finally {
    input.value = '';
    input.disabled = false;
  }
}
$('#editor-upload').addEventListener(
  'change',
  action((event) => upload(event.target, true)),
);
$('#settings-upload').addEventListener(
  'change',
  action((event) => upload(event.target, 'settings')),
);
$('#media-upload').addEventListener(
  'change',
  action((event) => upload(event.target, false)),
);
async function loadMedia() {
  const media = await api('media');
  $('#media-list').innerHTML = media.length
    ? media
        .map(
          (item) =>
            `<article class="admin-media-item"><img src="/admin${escape(item.url)}" alt="${escape(item.name)}" loading="lazy" /><p class="admin-media-name">${escape(item.name)}</p><p class="admin-help">${Math.max(1, Math.round(item.size / 1024))} KB</p><label><span class="sr-only">图片 Markdown 链接</span><input class="admin-media-url" readonly value="${escape(`![图片说明](${item.url})`)}" /></label><div class="admin-media-actions"><button class="admin-link" type="button" data-copy="${escape(item.url)}">复制链接</button><button class="admin-link danger" type="button" data-remove-media="${escape(item.name)}">删除</button></div></article>`,
        )
        .join('')
    : '<div class="admin-empty"><h2>还没有图片</h2><p>上传图片后，可在文章正文中引用。</p></div>';
}
$('#media-list').addEventListener(
  'click',
  action(async (event) => {
    const copy = event.target.closest('[data-copy]');
    if (copy) {
      try {
        await navigator.clipboard.writeText(
          `![图片说明](${copy.dataset.copy})`,
        );
        notice('Markdown 链接已复制。');
      } catch {
        copy.closest('article').querySelector('input').select();
        notice('链接已选中，请按 Ctrl / ⌘ + C 复制。');
      }
    }
    const remove = event.target.closest('[data-remove-media]');
    if (
      remove &&
      (await confirmAction(
        '删除图片？',
        '将删除这张源图片；正在被文章、关于页面或回收站引用的图片无法删除。之前发布的版本在重新构建前仍会保留它。',
        '删除图片',
      ))
    ) {
      await api('media', {
        method: 'DELETE',
        body: JSON.stringify({ name: remove.dataset.removeMedia }),
      });
      await Promise.all([loadMedia(), refresh()]);
      notice('图片已删除。');
    }
  }),
);
function renderPublication() {
  const publication = state.publication;
  if (!publication) return;
  $('#pending-dot').hidden = !publication.pending;
  $('#publication-state').textContent = publication.busy
    ? '正在构建，请稍候…'
    : publication.pending
      ? '有待发布的内容'
      : '所有已保存内容已构建';
  $('#publication-date').textContent =
    `上次成功发布：${dateLabel(publication.publishedAt)}`;
  $('#publish-button').disabled = publication.busy;
  $('#publish-button').textContent = publication.busy
    ? '正在构建…'
    : '构建并发布';
  $('#build-history').innerHTML = publication.history.length
    ? publication.history
        .map(
          (job) =>
            `<button class="admin-build-row" type="button" data-log="${escape(job.id)}"><time>${escape(dateLabel(job.startedAt))}</time><span class="admin-badge ${job.status === 'failed' ? 'failed' : job.status === 'succeeded' ? 'live' : 'ready'}">${{ failed: '失败', succeeded: '成功', running: '构建中' }[job.status]}</span><span>查看日志</span></button>`,
        )
        .join('')
    : '<p class="admin-empty">还没有构建记录。</p>';
  const job =
    publication.history.find((item) => item.id === state.logId) ||
    publication.history[0];
  $('#build-log').hidden = !job;
  $('#build-log').textContent = job?.log || '';
  clearTimeout(state.poll);
  if (publication.busy)
    state.poll = setTimeout(
      () => refresh().catch((error) => notice(error.message, true)),
      1500,
    );
}
$('#build-history').addEventListener('click', (event) => {
  const button = event.target.closest('[data-log]');
  if (button) {
    state.logId = button.dataset.log;
    renderPublication();
  }
});
$('#publish-button').addEventListener(
  'click',
  action(async () => {
    if (
      !(await confirmAction(
        '构建并发布网站？',
        '将发布网站设置、图片，以及所有已保存且日期已到的非草稿文章。构建期间暂时不能保存或删除内容。',
        '开始发布',
      ))
    )
      return;
    const result = await api('publish', { method: 'POST', body: '{}' });
    state.logId = result.id;
    await refresh();
    notice('构建已开始，可在下方查看结果。');
  }),
);
$('#auth-form').addEventListener(
  'submit',
  action(async (event) => {
    event.preventDefault();
    const authForm = event.currentTarget;
    if (
      state.setup &&
      authForm.elements.password.value !== authForm.elements.confirm.value
    )
      throw new Error('两次输入的密码不一致。');
    $('#auth-submit').disabled = true;
    try {
      const session = await api(state.setup ? 'setup' : 'login', {
        method: 'POST',
        body: JSON.stringify(Object.fromEntries(new FormData(authForm))),
      });
      authForm.elements.password.value = '';
      authForm.elements.confirm.value = '';
      notice('');
      await showWorkspace(session);
    } finally {
      $('#auth-submit').disabled = false;
    }
  }),
);
$('#logout').addEventListener(
  'click',
  action(async () => {
    if (
      (state.dirty || state.settingsDirty) &&
      !(await confirmAction(
        '退出登录？',
        '当前有未保存的修改，退出后将丢失。',
        '退出',
      ))
    )
      return;
    await api('logout', { method: 'POST', body: '{}' });
    dirty(false);
    settingsDirty(false);
    location.reload();
  }),
);
$('#password-form').addEventListener(
  'submit',
  action(async (event) => {
    event.preventDefault();
    const passwordForm = event.currentTarget;
    if (
      passwordForm.elements.password.value !==
      passwordForm.elements.confirm.value
    )
      throw new Error('两次输入的新密码不一致。');
    const button = passwordForm.querySelector('button');
    button.disabled = true;
    try {
      const session = await api('password', {
        method: 'POST',
        body: JSON.stringify(Object.fromEntries(new FormData(passwordForm))),
      });
      state.csrf = session.csrf;
      passwordForm.reset();
      notice('密码已更新，其他登录会话已失效。');
    } finally {
      button.disabled = false;
    }
  }),
);
window.addEventListener('beforeunload', (event) => {
  if (state.dirty || state.settingsDirty) event.preventDefault();
});
document.addEventListener('keydown', (event) => {
  if (
    (event.metaKey || event.ctrlKey) &&
    event.key.toLowerCase() === 's' &&
    ['editor', 'settings'].includes(state.view)
  ) {
    event.preventDefault();
    (state.view === 'settings' ? saveSettings() : save()).catch((error) =>
      notice(error.message, true),
    );
  }
});
try {
  const session = await api('session');
  if (session.authenticated) await showWorkspace(session);
  else showAuth(session.needsSetup);
} catch (error) {
  notice(error.message, true);
}
