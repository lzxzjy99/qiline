# GitHub 与 Cloudflare 发布

## Cloudflare Pages 迁移（2026-11-17）

已发布 `wrangler.json` 与 `npm run build:pages`，前端由 Pages 静态托管，`/api/rooms` 和子路径由 Pages Functions 处理。继续绑定原 `qiline-online` D1 数据库，不创建新库或重建表。规则与产品AI不变。

免费地址为 `https://qiline-online.pages.dev`，本机不使用代理时已返回 HTTP 200。Pages 项目已连接同一 GitHub 仓库、`main` 分支，构建命令 `npm ci && npm run test:online && npm run build:pages`，输出目录 `dist-pages`；预览发布关闭。`wrangler.json` 管理生产 D1 绑定。Pages 要求使用默认配置文件名，不支持通过 `--config` 指定自定义文件名。

本机手动更新命令：`npm run pages:deploy`。官方 Wrangler 登录需在已有权限之外加入 `pages:write`；不需要域名或 DNS 权限。GitHub Pages 的联机入口随本次迁移改为目标 Pages 地址。旧 Workers 入口保留，同一数据库中的房间数据继续存在，但浏览器身份和本地存档按域名隔离；旧房间浏览器身份不会自动迁移。

以下为原 Workers 发布流程，保留作为备用入口及历史配置。

GitHub 保存公开网站源码，Cloudflare Workers 运行网页及在线房间，D1 保存服务器棋谱。沿用现有产品AI 0.5.11，不上传本机研究目录、测试结果、存档、凭据或运行中的数据库。

## 首次配置

需要 Node.js 24 和本账号的 Cloudflare 登录：

```sh
npm ci
npx wrangler login --use-keyring --scopes account:read user:read workers:write workers_scripts:write d1:write
npm run cloudflare:setup
```

首次配置会创建 `qiline-online` D1 数据库，并将实际数据库ID和 `DB` 绑定写入 `wrangler.cloudflare.json`。数据库ID不是密码；此配置应与源码一起保存。再次执行会沿用已配置数据库。不要将旧 Sites 托管数据库的ID填入个人Cloudflare账号。

Drizzle 生成的SQL位于 `drizzle/`，配置脚本会自动写入 `migrations_dir: "drizzle"`。发布命令先应用尚未执行的迁移，再发布Worker；不会删除或重建已有表。

## 本机发布

```sh
npm run cloudflare:deploy
```

该命令构建同一套源码、核对规则与AI文件，再迁移数据库并发布。`wrangler.preview.json`仅用于本机预览，不能作为生产配置。

源码提交后，可用 `npm run publish:all` 推送同一源码提交，由已连接的Cloudflare自动检查、构建和发布。它要求工作区干净，推送失败立即停止；不会在本机同时重复部署。命令返回表示GitHub已接收，不能据此宣称Cloudflare已完成。GitHub推送需要本机已有Git登录；手动Cloudflare授权保存于Windows密钥管理器，不写入仓库。

当前公开源码：[lzxzjy99/qiline](https://github.com/lzxzjy99/qiline)。Cloudflare已发布入口为 [qiline-online.one-vote.workers.dev](https://qiline-online.one-vote.workers.dev)，原Sites入口为 [qiline-rebuild.xuanxliu.chatgpt.site](https://qiline-rebuild.xuanxliu.chatgpt.site)。本机直接访问workers.dev出现连接超时，不能据此宣称公网房间测试已通过；发布控制台与CLI已确认版本上线和数据库绑定。自定义域名未绑定。

## GitHub 自动部署

2026-11-17已连接 `lzxzjy99/qiline` 仓库，生产分支 `main`，根目录 `/`，预览构建关闭。GitHub应用安装范围只选择了此仓库。Cloudflare创建并保管自己的构建身份，本机授权不会复制到GitHub。

在Cloudflare Workers & Pages中为 `qiline-online` 连接本GitHub仓库，生产分支选择 `main`，根目录为仓库根目录：

- 构建命令：`npm ci && npm run test:online && npm run build && npm run check`
- 部署命令：`npm run cloudflare:publish`
- 非生产分支不执行生产发布命令。
- 使用Cloudflare平台配置的构建身份，不将访问令牌写入GitHub源码。

每次向 `main` 推送后，由Workers Builds构建并更新网站。以Cloudflare实际构建和部署成功结果为准，提交成功不等于网站发布成功。

原Sites地址继续保留，其版本通过Sites发布流程更新；它不会自动读取GitHub提交。两处同步的是源码版本，在线房间数据库各自独立；浏览器存档也按域名分别保存。自定义域名由用户决定后绑定到Cloudflare，本配置不包含任何自定义域名或DNS修改。

相关官方入口：[Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/)、[D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)、[Workers custom domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)。
