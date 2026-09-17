# GitHub 镜像包部署到 Ubuntu

发布页：[cyx2007/sparblog Releases](https://github.com/cyx2007/sparblog/releases)。下载 `.tar.gz` **部署附件**和对应 `.sha256`，GitHub 自动生成的 Source code 压缩包不含镜像。

每个包包含应用、Node.js、Astro 依赖及 Caddy 镜像，另附 Compose 配置、管理脚本和内部校验清单。服务器只需 Docker Engine、Compose v2 和 Ubuntu 自带的 Bash/coreutils/util-linux，无需安装 Node/npm/Git。镜像按固定 ID 启动，安装、升级和回滚均不从镜像仓库下载，也不现场制作镜像。文章发布仍由应用容器内的 Astro 构建静态页面。

## 首次安装

1. 按 [Docker 官方 Ubuntu 文档](https://docs.docker.com/engine/install/ubuntu/)安装 Engine 和 Compose 插件。使用 `docker compose version` 确认 Compose v2 可用。
2. 将 `sparsity.tech` 的 A/AAAA 指向服务器，开放 TCP 80/443，并确保没有其他程序占用。只有在 IPv6 可达时配置 AAAA。Caddy 会管理 HTTPS 证书。当前发布包的 canonical/RSS 域名为 `sparsity.tech`；更换域名还需要修改源码 `src/data/site.ts` 后重新发包。
3. 查看 `uname -m`：`x86_64` 选 `linux-amd64`，`aarch64`/`arm64` 选 `linux-arm64`。脚本还会核对实际 Docker 主机架构。以下用 `v1.0.0`、AMD64 举例。

```sh
sha256sum -c sparblog-v1.0.0-linux-amd64.tar.gz.sha256
tar -xzf sparblog-v1.0.0-linux-amd64.tar.gz
cd sparblog-v1.0.0-linux-amd64
sudo bash ./manage.sh install /opt/sparblog https://sparsity.tech
sudo /opt/sparblog/manage.sh logs
```

打开日志里的私密初始化链接，创建管理员，再点击「发布 → 构建并发布」。首次发布前首页还没有公开内容，后台可以正常访问。之后检查首页、`/admin/`、`/rss.xml` 和任意不存在的路径（应返回 404）。请勿分享初始化日志。

下载包可在另一台电脑完成，再通过 SCP 上传。包内两个镜像均已包含依赖，服务器不需要访问 Docker Hub 或 GHCR。上述步骤不包含 Docker 本身的离线安装。

## 升级

下载新版附件及校验文件，先校验再解压，然后在**原安装目录**调用管理脚本：

```sh
sha256sum -c sparblog-v1.1.0-linux-amd64.tar.gz.sha256
tar -xzf sparblog-v1.1.0-linux-amd64.tar.gz
sudo /opt/sparblog/manage.sh upgrade "$PWD/sparblog-v1.1.0-linux-amd64"
sudo /opt/sparblog/manage.sh status
```

脚本检查内部校验和、架构和数据格式，导入镜像，停止后台并等待正在进行的发布完成，然后备份持久数据并启动新后台。健康检查失败时恢复上一程序版本。每个版本目录不可覆盖，同版本重新选择使用 `rollback`。首次安装中断时可在排除故障后用 `upgrade` 重试原包。

后台升级会使登录会话失效，重新登录后点击「构建并发布」更新公开布局、样式等。程序升级不会自动发布草稿或尚未发布的修改。

只有后台变更时，Caddy 容器继续提供原来的公开页面。Caddy 镜像或端口等代理配置变更可能重建代理容器，因此整个程序栈升级不承诺完全无中断。日常文章和网站设置发布无需重启容器。

## 数据保留与回滚

默认 Compose 项目名固定为 `sparblog`，所有版本共用同一组命名卷：

| 卷后缀                       | 内容                        |
| ---------------------------- | --------------------------- |
| `admin_state`                | 账号、回收站、构建记录      |
| `notes`                      | Markdown 文章               |
| `settings`                   | 网站介绍和关于正文          |
| `images`                     | 上传图片                    |
| `published`                  | 已发布版本和 `current` 链接 |
| `caddy_data`、`caddy_config` | HTTPS 证书及代理状态        |

升级时已有内容卷覆盖镜像内的初始内容，六篇默认示例和默认网站设置不会覆盖线上数据。不要更改 `/opt/sparblog/config.env` 中的项目名，不要执行 `docker compose down -v` 或清理这些卷。备份副本应定期复制到另一台机器。

```sh
sudo /opt/sparblog/manage.sh rollback v1.0.0
sudo /opt/sparblog/manage.sh backup
```

回滚重新启用已安装的旧程序并保留**当前内容**；公开页面也保留当前快照，后台重新发布后才会使用旧版模板。它不会把文章、图片或账号恢复为旧数据。脚本只接受相同数据格式版本；未来涉及数据迁移的升级必须另行提供迁移方案。

每次升级、回滚及手动备份都在后台停止写入时生成 `/opt/sparblog/backups/<时间-随机值>/data.tar.gz`、配置和校验文件；备份目录仅运行脚本的用户可访问。公开网站在内容备份期间仍可读取，Caddy 证书状态可能继续更新；这些证书可由 Caddy 自动续期或重新签发。

程序目录结构：

```text
/opt/sparblog/
  config.env       # 固定项目名、域名、端口；升级时不覆盖
  manage.sh        # 当前管理命令
  current          # 指向当前程序版本，不是文章的公开目录
  proxy/Caddyfile
  releases/v*/     # 保留镜像包，可离线回滚
  backups/         # 含私有内容，不能放进 Web 根目录
```

恢复到新的干净主机时，先准备同版本包和原 `config.env`，导入镜像并创建相同项目名的空卷；在所有容器停止时将 `data.tar.gz` 中各目录恢复到对应卷，保留文件属主和权限，再启动对应版本。不要把备份直接解压到运行中的卷，也不要把备份账号或草稿上传 GitHub。不要删除 `current` 正在引用的程序版本，旧镜像包和备份需按磁盘容量自行保留。

已有 `compose.admin.yaml` 或 systemd 部署使用不同的数据位置。这个流程默认新安装，不会自动查找或迁移旧实例；迁移前停止旧后台并备份文章、图片、网站设置、账号和公开版本，再按上述卷映射恢复。不能让两个后台同时写同一组内容。

## 本机 Linux 验证

使用 HTTP 回环地址和独立项目名，不占用正式域名端口：

```sh
SPARBLOG_PROJECT=sparblog-test SPARBLOG_HTTPS_PORT=8443 \
  bash ./manage.sh install /tmp/sparblog-test http://localhost:8080
```

正式部署使用 HTTPS。HTTP 仅允许 localhost/127.0.0.1。Node 的 4330 端口只在容器网络内部使用。

## 维护者发包

`npm run release` 保留原有纯静态网页包行为。完整镜像包使用：

```sh
npm ci
npm run verify
npm run test:publishing
npm run test:admin
npm run test:release
npm run release:docker -- v1.0.0 linux/amd64
```

构建要求原生对应架构的 Linux Docker daemon（ARM Mac 的 Docker Desktop 可构建 ARM64）。镜像包输出到 `artifacts/`，不允许覆盖同名归档。包中的程序源码来自当前构建目录，发正式版本使用干净提交；不要把私有文章或服务器状态带进公共仓库或构建目录。

GitHub Actions 在 PR 和主分支上运行代码检查及两种原生架构的实际部署测试。发布标签 `vX.Y.Z` 前更新 `package.json`/锁文件版本、合并 PR 并确认 CI 成功，然后推送与 package 版本一致的标签。工作流会在两个架构测试通过后创建草稿 Release，上传四个附件并下载验证校验和，最后公开 Release。标签必须位于 main 历史上。失败的草稿应检查后人工处理，不覆盖已经发布的版本。

工作流不需要服务器 SSH 密钥，不会登录 Ubuntu 主机、修改 DNS 或自动升级生产站点。服务器何时安装哪个版本由部署命令决定。
