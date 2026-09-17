# sparsity.tech

个人技术博客。采用已选定的传统双栏布局、衬线文章标题和蓝灰配色。MIT 6.004 旧课件只作为视觉参考。页面以文章为主，不使用课程结构、卡片、横幅或复杂动效。

工具链：**Astro 7 + TypeScript + Markdown + 原生 CSS**。公开网站的构建结果是普通 HTML、CSS 与少量用于归档搜索的 JavaScript。纯静态部署只需要 Caddy；启用管理后台时，额外运行一个 Node.js 服务。文章仍保存为 Markdown，无数据库。

## 管理后台

```sh
npm ci
npm run admin
```

默认打开 **[http://127.0.0.1:4330/admin/](http://127.0.0.1:4330/admin/)**。首次运行时，终端会显示一个带初始化密钥的私密链接；通过该链接设置管理员账号和密码（至少 12 个字符）。没有默认密码。密钥只在创建首个管理员前有效，重新启动未初始化的服务会更换密钥。账号创建后使用普通后台地址登录。

- **文章**：搜索、状态筛选、新建、修改 Markdown 与摘要、分类、日期、草稿和示例标记。保存路径后不再改名，避免破坏既有链接。
- **网站设置**：修改博客侧栏的一句话介绍和关于页面正文。关于页面使用同款 Markdown 编辑器，支持预览和图片上传。设置保存在 `src/data/settings/site.json`，保存后通过「发布」更新公开页面；网站介绍也会更新网页摘要和 RSS 简介。
- **编辑器**：使用 [EasyMDE](https://github.com/Ionaru/easy-markdown-editor)，提供中文格式工具栏、Markdown 语法提示、列表续写、链接/代码/表格插入、撤销重做、字符计数和图片粘贴/拖入。`Ctrl / ⌘ + B` 加粗、`I` 斜体、`K` 插入链接、`S` 保存；格式栏可用左右方向键切换，Tab 可离开编辑区域。实时预览仍使用隔离的私密预览，文件保留原始 Markdown。编辑器资源随后台本地提供，不依赖 CDN。多个窗口编辑同一篇文章时，过期版本不能覆盖新版本。原有 YAML 注释和额外字段会保留。
- **图片**：上传 PNG、JPEG、GIF、WebP（每张最多 8 MB），复制 Markdown 链接；文章、关于页面和回收站引用的图片不能删除。图片在发布后可通过链接公开访问。
- **回收站**：恢复文章源文件和原有状态，不覆盖同名文章。
- **发布**：在私有临时目录完成 Astro 检查、构建与链接/索引验证，成功后原子切换 `published/current`。文章、图片、页面布局、样式与站点配置的改动均会标为待发布。失败保留上一公开版本，并显示日志。发布过程中暂停内容写入。
- **账号**：修改密码、退出；改密会使其他会话失效。会话有效期 12 小时，服务重启后需要重新登录。

**保存与发布是两步**：先保存文章或网站设置，再到「发布」点击「构建并发布」。它发布网站设置、图片，以及所有已保存、非草稿且日期已到的文章。未来文章到期后仍需手动重新构建，后台不运行定时发布任务。已有静态部署只有切换到后台生成的 `current` 目录后，才会显示这些更新。这里的发布只更新配置的本机/服务器目录，不会上传远程主机或修改 DNS。

`npm run admin` 同时在根路径提供已发布版本，便于本机检查；第一次构建前根路径返回 503。`npm run dev` 仍使用原有 4321 端口，按工作区源文件预览，与后台生成的公开版本相互独立。

后台配置通过 `.env` 或环境变量读取，见 [.env.example](.env.example)。服务器部署使用精确的 `ADMIN_ORIGIN=https://sparsity.tech`，由 Caddy 提供 HTTPS，Node 服务只监听回环地址。后台不进入静态包、搜索、RSS 或 sitemap，草稿预览需要认证。密码使用带随机盐的 scrypt 保存，会话使用 HttpOnly / SameSite Cookie；生产 HTTPS Cookie 带 Secure。写操作检查 Origin 和 CSRF，文件路径检查会拒绝越界和符号链接。

遗忘密码时，先停止后台，再在项目目录的交互式终端执行 `npm run admin:reset-password`，然后重新启动后台。密码输入不会回显。每个内容目录只运行一个后台实例。

运行文件：`admin/`；私有账号、回收站、构建记录：`.admin/`；文章：`src/content/notes/`；图片：`public/images/`；公开版本：`published/`。备份时保留文章、图片与 `.admin/`，且不要把 `.admin/` 放在 Web 根目录。历史公开版本保留在 `published/releases/`，磁盘不足时可在停止构建后手动清理未被 `current` 指向的旧版本。

可部署到服务器的完整步骤见 [后台部署说明](deploy/ADMIN.md)。

## 本地运行

需要 Node.js 22.12+；本项目锁定 Node 22.23.1 和 npm 依赖。

```sh
npm ci
npm run dev
```

打开 [http://127.0.0.1:4321/](http://127.0.0.1:4321/)。

- 首页每页 4 篇文章，自动分页。
- `/archive/`：按年份归档，支持标题、分类与正文搜索。
- `/category/分类名/`：分类文章。
- `/notes/文章文件名/`：阅读页，包含前后文章导航。
- `/about/`：关于；`/rss.xml`：RSS 订阅。
- 旧 `/a/`、`/b/`、`/c/` 及 `/compare/` 路径自动跳转到正式页面。

禁用 JavaScript 后仍可阅读、分页和浏览归档；搜索框自动隐藏，完整归档继续可用。

## 备案页脚

全站共用静态备案页脚，在页面底部居中显示 `粤ICP备2026118989号` 和 `粤公网安备44030002016095号`，分别链接工信部备案管理系统与该网站的公安备案查询页。桌面端并排、手机端分行；禁用 JavaScript 后仍可显示和访问。

备案号和查询地址集中在 `src/data/site.ts` 的 `registration` 中。公安备案图标为 `public/beian.png`，沿用旧项目中保存的用户原图，按原比例显示在公安备案编号之前。展示依据见下方工信部和深圳市公安局官方指引。

## 写文章

```sh
npm run new:post -- my-first-note "第一篇文章"
```

该命令创建 `src/content/notes/my-first-note.md`，默认是草稿，不覆盖已有文件。也可以直接创建 Markdown 文件：

```yaml
---
title: '第一篇文章'
description: '一两句摘要，会出现在首页和 RSS。'
date: 2026-09-17
category: 计算机
draft: false
---
```

在第二个 `---` 后写正文。可选字段：

| 字段      | 用途                                                            |
| --------- | --------------------------------------------------------------- |
| `updated` | 更新日期，不得早于发表日期                                      |
| `excerpt` | 首页摘要段落数组；省略时使用 `description`                      |
| `draft`   | 默认 `false`；`true` 时不生成页面，也不进入搜索、RSS 和站点地图 |
| `example` | 默认 `false`；`true` 时显示“示例”，不进入 RSS 和站点地图        |

未来日期的文章也会从所有公开输出中排除。日期到达后**需要重新构建并部署**，静态服务器不会自动定时发布。草稿在公开预览中隐藏；使用管理后台的文章预览检查正文，无需取消草稿状态。

支持代码高亮、表格、列表、引用、图片与普通 Markdown 链接。图片放在 `public/images/`，正文中用 `![替代文本](/images/example.png)` 引用。使用 `/notes/my-first-note/` 链接到另一篇文章。

目前保留六篇用户确认的示例文章，日期旁均有“示例”标记。示例页和仅含示例的列表页带 `noindex`；RSS 目前为空。写入真实文章后，正式文章会自动进入 RSS、站点地图并具备搜索收录元数据。替换示例正文时移除 `example: true` 即可。作者经历、社交账号和联系方式未虚构；可在关于页自行补充。

## 代码位置

| 文件                            | 用途                                   |
| ------------------------------- | -------------------------------------- |
| `src/data/site.ts`              | 域名、名称、简介、备案信息、分页与导航 |
| `src/content/notes/*.md`        | 文章源文件                             |
| `src/content.config.ts`         | 内容字段校验                           |
| `src/lib/notes.ts`              | 统一的文章可见性、排序与链接           |
| `src/components/BlogHome.astro` | 首页与分页                             |
| `src/layouts/SiteLayout.astro`  | 页头、导航、页尾与 SEO                 |
| `src/styles/global.css`         | 唯一的样式文件，含移动端和打印         |
| `src/data/settings/site.json`   | 后台可编辑的网站介绍和关于正文         |
| `src/pages/about.astro`         | 关于页布局                             |

## 检查与打包

```sh
npm run verify
npm run test:publishing
npm run test:admin
npm run format:check
npm run release
```

`verify` 执行 Astro/TypeScript 检查、静态构建、所有站内链接与资源检查，并验证 canonical、RSS、站点地图和搜索索引。`test:publishing` 在临时副本中验证草稿和未来文章不泄漏、示例排除、XML 转义、空博客与安全的新建文章命令，不修改实际文章。

`release` 重新验证并生成 `artifacts/sparsity-tech-static.tar.gz` 和 `.sha256` 校验文件。压缩包内仅含 `dist/` 的公开产物，可直接上传至静态服务器。运行 `npm run format` 可统一代码格式。

`test:admin` 在临时副本中测试登录、CSRF、越界路径、文章并发编辑、图片、回收站、私密预览、密码更新、真实构建以及失败保留上一版。浏览器验收可运行 `npx playwright install chromium` 后执行 `npm run test:admin:browser`；已安装 Chrome 时也可使用 `ADMIN_TEST_BROWSER=chrome npm run test:admin:browser`。测试覆盖桌面和 390 px 手机、预览隔离、导航、搜索及键盘焦点；截图写入已忽略的 `test-results/`。

## Ubuntu 26.04 部署

### GitHub Releases 完整镜像包（含管理后台）

推荐在 Ubuntu 使用 [GitHub Release 部署包](https://github.com/cyx2007/sparblog/releases)。它包含应用和 Caddy 的预构建镜像、校验文件及安装/升级/回滚脚本，分别提供 AMD64 和 ARM64 包。服务器仅需 Docker Engine 与 Compose v2，无需安装 Node/npm/Git 或现场制作镜像。

校验并解压部署附件后，执行 `sudo bash ./manage.sh install /opt/sparblog https://sparsity.tech`，通过 `sudo /opt/sparblog/manage.sh logs` 获取首次管理员初始化链接。后续用 `sudo /opt/sparblog/manage.sh upgrade /path/to/extracted-bundle` 升级，文章、图片、网站设置、账号与公开版本保存在独立命名卷中。

具体下载、数据保留、备份和回滚步骤见 [GitHub 镜像包部署说明](deploy/RELEASES.md)。下方纯静态包和源码 Compose 部署方式继续可用。

### 静态文件 + Caddy

1. 在本地或 CI 运行 `npm ci`、`npm run release`，上传压缩包及其 `.sha256` 文件到 Ubuntu。
2. 按 [Caddy 官方安装说明](https://caddyserver.com/docs/install#debian-ubuntu-raspbian)安装 Caddy。
3. 在压缩包所在目录执行以下命令，校验、解压并切换版本：

```sh
sha256sum -c sparsity-tech-static.tar.gz.sha256
release_id="$(date +%Y%m%d-%H%M%S)"
release_dir="/var/www/sparsity/releases/$release_id"
sudo install -d -m 755 "$release_dir"
sudo tar -xzf sparsity-tech-static.tar.gz -C "$release_dir"
sudo chmod -R a+rX "$release_dir"
sudo ln -s "$release_dir" /var/www/sparsity/current.next
sudo mv -Tf /var/www/sparsity/current.next /var/www/sparsity/current
```

4. 将 `deploy/Caddyfile` 的站点块合并到 `/etc/caddy/Caddyfile`，保留服务器上其他站点的配置。
5. 将 `sparsity.tech` 的 A/AAAA 记录指向该主机，开放 TCP 80/443。若配置 AAAA，确保 IPv6 也能访问。
6. 执行校验和 reload：

```sh
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
curl -I https://sparsity.tech/
curl -I https://sparsity.tech/rss.xml
curl -I https://sparsity.tech/page-that-does-not-exist/
```

首页应返回 200，RSS 应使用 XML 内容类型，不存在的页面应返回 404。Caddy 为域名管理 HTTPS 证书；旧预览路径返回 301，带内容哈希的静态资源使用长期缓存。后续更新重复上传与切换步骤即可；回滚时用同样的 `current.next` + `mv -Tf` 流程指向旧版本目录。

### Docker Compose

按 [Docker 官方 Ubuntu 安装说明](https://docs.docker.com/engine/install/ubuntu/)安装 Engine 与 Compose 插件。在包含源代码的项目目录执行：

```sh
cp .env.example .env
docker compose up -d --build
```

默认访问 `http://服务器IP:8080`。正式上线前，将 `.env` 改成：

```dotenv
SITE_ADDRESS=sparsity.tech
HTTP_PORT=80
HTTPS_PORT=443
```

配置 DNS 并开放端口后重新运行 `docker compose up -d --build`。证书持久化在 Compose 卷中，更新时保留这些卷。

完整镜像包由 GitHub Actions 构建，并在原生 AMD64、ARM64 Ubuntu 上运行部署测试；具体结果以对应版本的 CI 为准。真实 DNS、HTTPS 与目标服务器运行结果仍需在部署时验证。

## 参考

- [工信部《非经营性互联网信息服务备案管理办法》](https://www.miit.gov.cn/gyhxxhb/jgsj/cyzcyfgs/bmgz/xxtxl/art/2024/art_84a0cfa0ebd049bbbe751dca9a008e56.html)：第十三条要求在主页底部中央标明备案编号并链接备案管理系统。
- [深圳市公安局新办网站备案指引](https://ga.sz.gov.cn/ZT/HLWSYSQ/)：办结后将公安备案编号、查询代码与备案图标展示于网站底部。
- [MIT 6.004 · Spring 2009](https://ocw.mit.edu/courses/6-004-computation-structures-spring-2009/pages/lecture-notes/)：仅参考早期技术页面的排版气质。
- [Astro 静态端点](https://docs.astro.build/en/guides/endpoints/)与[路由重定向](https://docs.astro.build/en/guides/routing/#redirects)：构建 RSS、搜索索引、站点地图和旧路径跳转。
