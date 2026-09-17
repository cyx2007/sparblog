# 管理后台部署

后台使用独立 Node.js 22.12+ 进程，Caddy 负责 HTTPS 和公开静态文件。域名仍为 `sparsity.tech`。以下是部署步骤；仓库中的配置文件不代表服务器已部署。

Ubuntu 推荐使用 [GitHub Releases 完整镜像包](RELEASES.md)：无需上传源码或在服务器构建镜像，附安装、升级、备份和回滚脚本。以下保留 systemd 和源码 Docker Compose 部署方式。

## Ubuntu + systemd

1. 安装 Node.js 22.12+、npm 和 [Caddy](https://caddyserver.com/docs/install#debian-ubuntu-raspbian)。确认 `node --version` 和 `command -v node`；如果 Node 不在 `/usr/bin/node`，修改 `sparsity-admin.service` 的 `ExecStart`。
2. 创建专用用户，并将完整源代码放到 `/opt/sparsity`。不要上传 `node_modules`、`.admin`、`published`、`.env` 或测试目录。如果迁移已有后台，应单独备份并安全迁移内容和私有状态。

```sh
sudo useradd --system --user-group --home-dir /opt/sparsity --shell /usr/sbin/nologin sparsity
sudo install -d -o sparsity -g sparsity -m 755 /opt/sparsity /var/www/sparsity
# 将源代码复制到 /opt/sparsity 后：
sudo chown -R sparsity:sparsity /opt/sparsity
sudo install -d -o sparsity -g sparsity -m 700 /opt/sparsity/.admin
sudo install -d -o sparsity -g sparsity -m 755 /opt/sparsity/public/images
sudo -u sparsity sh -c 'cd /opt/sparsity && npm ci --cache /tmp/sparsity-npm-cache'
```

3. 创建 `/etc/sparsity-admin.env`（root 所有，权限 600）：

```dotenv
ADMIN_HOST=127.0.0.1
ADMIN_PORT=4330
ADMIN_ORIGIN=https://sparsity.tech
ADMIN_STATE_DIR=/opt/sparsity/.admin
ADMIN_PUBLISH_DIR=/var/www/sparsity
```

4. 安装 systemd 单元并启动：

```sh
sudo cp /opt/sparsity/deploy/sparsity-admin.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now sparsity-admin
sudo journalctl -u sparsity-admin -n 30 --no-pager
```

首次日志包含创建管理员的私密链接。仅管理员应能阅读这些日志，链接不要分享。后台从 `.admin/account.json` 读取账号，无预设密码。首次创建后，初始化链接即失效。

5. 将 `deploy/Caddyfile` 的站点块合并到 `/etc/caddy/Caddyfile`，保留其他站点。它将 `/admin` 与 `/admin/*` 转发到 `127.0.0.1:4330`，公开网站仍由 Caddy 从 `/var/www/sparsity/current` 读取。保留原有兼容路径跳转。配置 DNS、开放 80/443 后校验并重载：

```sh
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

6. 访问初始化链接，创建管理员，然后点击「发布 → 构建并发布」。首次安装没有公开版本，构建前首页会返回错误；如果 `current` 已指向以前的静态版本，该版本会保留到构建成功。检查 `https://sparsity.tech/`、`/admin/`、`/rss.xml` 和一个不存在的地址分别能正常访问或返回 404。

运行一次后台实例即可。服务的写权限限制在文章、图片、网站设置（`src/data/settings/`）、私有状态与公开版本目录，其他源文件只读。更新代码前停止后台，备份并保留上述数据目录，更新依赖后重启并从后台重新构建。网站介绍和关于正文可在「网站设置」中修改；域名与备案信息仍在源代码中配置。

从旧版升级时，请同时更新 systemd 单元并执行 `systemctl daemon-reload`，确认 `/opt/sparsity/src/data/settings/` 由 `sparsity` 用户所有且可写。后续覆盖源代码时保留这里的 `site.json`，避免覆盖已保存的网站设置。

忘记密码时：

```sh
sudo systemctl stop sparsity-admin
cd /opt/sparsity
sudo -u sparsity npm run admin:reset-password
sudo systemctl start sparsity-admin
```

如果自定义了私有状态目录，重置命令也需使用相同的 `ADMIN_STATE_DIR`。

## Docker Compose

使用独立的 `compose.admin.yaml`，不要与只读静态模式的 `compose.yaml` 同时占用相同端口。设置 `.env`：

```dotenv
SITE_ADDRESS=sparsity.tech
ADMIN_ORIGIN=https://sparsity.tech
HTTP_PORT=80
HTTPS_PORT=443
```

```sh
docker compose -f compose.admin.yaml up -d --build
docker compose -f compose.admin.yaml logs admin
```

通过日志中的私密链接创建管理员，然后构建发布。Node 的 4330 端口只在 Compose 内部网络开放；只有 Caddy 暴露 80/443。`notes`、`images`、`settings`、`admin_state`、`published` 五个卷持久保存文章、图片、网站设置、账号及发布内容；`caddy_data` 保存证书。首次创建内容卷时包含仓库里的六篇示例文章和默认网站设置。不要执行 `down -v`，它会删除这些持久数据。

本机验证可设置 `SITE_ADDRESS=:80`、`ADMIN_ORIGIN=http://localhost:8080`、`HTTP_PORT=8080`、`HTTPS_PORT=8443`；正式上线时改为 HTTPS 域名。更新镜像保留数据卷，新镜像中的示例内容不会覆盖已有文章。

重置密码先停止 admin，再执行交互式一次性容器：

```sh
docker compose -f compose.admin.yaml stop admin
docker compose -f compose.admin.yaml run --rm --no-deps admin npm run admin:reset-password
docker compose -f compose.admin.yaml start admin
```

## 备份与恢复

停止后台后备份 `src/content/notes/`、`public/images/`、`src/data/settings/`、`.admin/`，以及 `published/`（服务器模式对应 `/var/www/sparsity/`）。账号文件与回收站含私有内容，备份不要置于 Web 根目录。Docker 需备份相应命名卷。恢复时保留原有文件权限，删除已停止实例留下的 `server.lock`，再启动服务。

构建失败不会切换 `current`。需要人工回滚时，先停止后台，用同文件系统的临时符号链接和 `mv -Tf` 将 `current` 指向一个已验证的旧 release，再重新启动。回滚只恢复公开快照；源 Markdown 和图片保持当前内容，下一次发布会重新构建它们。构建记录可能显示回滚前的最后一次成功时间，回滚后应再核对实际页面。

参考：[Caddy reverse_proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)、[Node.js scrypt](https://nodejs.org/api/crypto.html#cryptoscryptpassword-salt-keylen-options-callback)、[Astro 静态构建](https://docs.astro.build/en/reference/cli-reference/#astro-build)。
