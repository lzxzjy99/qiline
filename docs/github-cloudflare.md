# GitHub 与 Cloudflare 发布

GitHub 保存公开网站源码，Cloudflare Workers 运行网页及在线房间，D1 保存服务器棋谱。沿用现有产品AI 0.5.11，不上传本机研究目录、测试结果、存档、凭据或运行中的数据库。

## 首次配置

需要 Node.js 24 和本账号的 Cloudflare 登录：

```sh
npm ci
npx wrangler login
npm run cloudflare:setup
```

首次配置会创建 `qiline-online` D1 数据库，并将实际数据库ID和 `DB` 绑定写入 `wrangler.cloudflare.json`。数据库ID不是密码；此配置应与源码一起保存。再次执行会沿用已配置数据库。不要将旧 Sites 托管数据库的ID填入个人Cloudflare账号。

Drizzle 生成的SQL位于 `drizzle/`，配置脚本会自动写入 `migrations_dir: "drizzle"`。发布命令先应用尚未执行的迁移，再发布Worker；不会删除或重建已有表。

## 本机发布

```sh
npm run cloudflare:deploy
```

该命令构建同一套源码、核对规则与AI文件，再迁移数据库并发布。`wrangler.preview.json`仅用于本机预览，不能作为生产配置。

## GitHub 自动部署

在Cloudflare Workers & Pages中为 `qiline-online` 连接本GitHub仓库，生产分支选择 `main`，根目录为仓库根目录：

- 构建命令：`npm ci && npm run test:online && npm run build && npm run check`
- 部署命令：`npm run cloudflare:publish`
- 非生产分支不执行生产发布命令。
- 使用Cloudflare平台配置的构建身份，不将访问令牌写入GitHub源码。

每次向 `main` 推送后，由Workers Builds构建并更新网站。以Cloudflare实际构建和部署成功结果为准，提交成功不等于网站发布成功。

原Sites地址继续保留，其版本通过Sites发布流程更新；它不会自动读取GitHub提交。两处同步的是源码版本，在线房间数据库各自独立；浏览器存档也按域名分别保存。自定义域名由用户决定后绑定到Cloudflare，本配置不包含任何自定义域名或DNS修改。

相关官方入口：[Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/)、[D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)、[Workers custom domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)。
