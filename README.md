# Forge 市场镜像

面向免费版 EdgeOne Makers 的只读市场镜像，兼容 AstralParty.Toys 的“市场地址”设置。项目只提供 API 和镜像文件，不提供网页，也不代理任意 GitHub 链接。

每天同步上游 Forge 的模组目录、全部已发布版本 ZIP、封面与贴纸资源；ZIP 保持原始字节并核对 SHA-256。同步与检查成功后，GitHub Actions 会把 `public/`、`generated/` 提交回公开仓库，供下载或日后部署。不发布任何服务，也不需要 EdgeOne 凭据。

本次仅创建公开 GitHub 项目。EdgeOne 部署是未来可手动启用的选项，推送和每日计划均不会触发部署。

## 本地运行

需要 Node.js 22 或更新版本：

```powershell
npm ci
npm test
npm run build
npm run dev
```

新检出的仓库已经包含上次成功同步的快照；`npm ci`、测试、构建与本地运行可以使用已有快照，不需要连接上游市场。需要更新到当前市场内容时执行 `npm run sync`。

同步会访问 `https://forge.hiynet.com` 及其声明的模组包来源。同步器只下载与校验，不加载 DLL。

`public/` 和 `generated/` 是可重新生成、需要提交 Git 的镜像数据；作者、来源、许可证与说明等原始元数据一并保留。`.cache/forge-mirror/` 保存已核验包供后续同步复用，不提交 Git。构建验证现有快照，不会自动联网同步。

## Toys 接入

在 Toys 的系统设置中，将“市场地址”设置为部署后的 HTTPS 根地址，例如 `https://mirror.example.com`，不要附加 `/api` 或 `/api/mods`。此项目不需要修改“GitHub 下载镜像”设置。

先访问 `/api/health` 核对快照生成时间，再在 Toys 中刷新市场、选择版本并安装。

| 路径 | 行为 |
| --- | --- |
| `/`、`/api/health` | JSON 状态与快照信息 |
| `/api/mods` | 列表；支持 `lang/query/tag/sort/page/pageSize` |
| `/api/mods/{id}` | 详情与所有镜像版本 |
| `/api/mods/{id}/download?version=...` | 跳转到已校验的同源静态 ZIP；省略版本取最新版本 |
| `/api/mods/{id}/cover` | 跳转到同源封面 |
| `/api/stickers` | 贴纸目录 |
| `/api/mod-stickers?modIds=...` | 同步时的贴纸计数快照，`reactedByMe` 始终为 `false` |
| `POST /api/mod-stickers/{id}/reactions` | 返回 `405`；镜像只读，不接受回应写入 |

保留 `zh-Hans`、`zh-Hant`、`en`、`ja` 四种语言。下载统计与贴纸计数是同步时的上游快照，不代表镜像站实时统计。未知 API 返回 JSON 404，不回退到 HTML。

## 部署 EdgeOne Makers

本地已经登录 EdgeOne CLI 时，在项目根目录执行：

```powershell
npm run sync
npm test
npm run build
npx --yes edgeone@1.6.41 makers deploy -n forge-web-mirror --area overseas --skip-ai-gateway-sync --json
```

项目名称可替换。`--area overseas` 选择全球不含中国大陆区域；如使用已备案域名并需要大陆节点，可按账号实际开通情况选择 `global`。

不要将 `public/` 作为部署目录参数：CLI 需要从项目根目录自动构建并一并打包 `edge-functions/`。`.edgeone/` 中可能存在认证信息，不能提交或分享。

正式供 Toys 使用前，应绑定长期可用的自定义域名和 HTTPS。平台默认项目/部署域名在中国大陆的预览访问链接有时效限制，不适合作为固定市场地址。选择包含中国大陆节点的区域时，自定义域名需要符合平台备案要求。

## GitHub Actions 每日同步

项目公开仓库为 [Thisisseanxu/forge-web-mirror](https://github.com/Thisisseanxu/forge-web-mirror)，默认分支为 `main`。项目附带 `.github/workflows/sync-deploy.yml`，支持代码推送、手动触发和每日计划执行。

每次默认执行 `npm ci → npm run sync → npm test → npm run build → 提交 public/generated → 上传 artifact`。所有步骤成功后，机器人仅暂存 `public/`、`generated/`；有改动才创建 `chore: sync Forge market snapshot [skip ci]` 提交，并在 `git pull --rebase` 成功后推送到 `main`，不强制推送。同步、校验或变基冲突会令执行失败，不把不完整快照提交到远端。

仓库的 [public](https://github.com/Thisisseanxu/forge-web-mirror/tree/main/public) 目录包含原始 ZIP、封面和贴纸，[generated](https://github.com/Thisisseanxu/forge-web-mirror/tree/main/generated) 包含 API 快照。工作流对这两个目录的单独推送设置了 `paths-ignore`，机器人提交也带 `[skip ci]`，避免递归触发。

在 Actions 运行记录的 **Artifacts** 区域，也可下载 `forge-mirror-<运行编号>`，取得快照、镜像文件、函数代码及构建配置；artifact 保留 7 天。Git 提交中的文件不会因为 artifact 到期而删除。此流程不会自动部署云端服务。

计划为 UTC `19:30`，即北京时间次日 `03:30`，每天一次。GitHub 的计划任务可能排队延迟，不保证准点触发；计划仅在默认分支运行，公开仓库长期无活动可能被 GitHub 自动停用。可在 Actions 页面使用 **Run workflow** 手动恢复/补跑，保持 `deploy` 未选中即可只同步。

Actions 使用仓库自带的 `GITHUB_TOKEN` 和 `contents: write` 权限提交，不需要配置额外的 GitHub Token 或任何 EdgeOne Secret。若开启分支保护，需允许机器人按仓库规则写入 `main`，否则推送会失败；工作流不会绕过保护或强制覆盖提交。

Actions 缓存用于减少重复下载，缓存缺失时仍会校验并补齐全部版本。GitHub Actions 的运行时间、缓存及 artifact 配额由 GitHub 单独计算，不包含在 Makers 免费额度内。ZIP 的版本变化会增加 Git 历史体积，需根据长期使用情况维护仓库。

### 日后手动启用 EdgeOne 部署

仅当需要实际发布服务时，在仓库 Settings → Secrets and variables → Actions 配置：

| 类型 | 名称 | 内容 |
| --- | --- | --- |
| Secret | `EDGEONE_API_TOKEN` | EdgeOne Makers 控制台创建的 API Token，所属账号/工作空间应与目标项目一致 |
| Variable，可选 | `EDGEONE_PROJECT_NAME` | Makers 项目名，默认 `forge-web-mirror` |
| Variable，可选 | `EDGEONE_AREA` | `overseas`（默认）或 `global` |

然后在 **Run workflow** 中主动选中 `deploy`。只有这次显式勾选的手动执行会额外部署；每日计划和推送仍然只同步。未配置 Secret 时，勾选部署的执行会立即报错，普通同步不受影响。Token 通过 GitHub Secret 注入，不写入源文件或日志。

## 免费版边界

- Makers 静态单文件最大 25 MiB；同步器遇到无法容纳或校验不通过的包应中止，不发布缺失版本的“全量镜像”。
- 免费项目总存储及文件数量受平台配额约束；历史部署也可能占用存储，需定期在控制台删除不再保留的部署。
- ZIP 和图片使用静态托管，API 使用 Edge Functions；不需要 CVM、数据库或公网 Blob 下载服务。
- 这是定时保存的镜像：上游下架或更新在下次成功同步后体现。同步失败不会生成新的成功产物；未来手动启用部署后，同步失败也不会替换旧线上快照。需关注 Actions 失败通知。
- 程序保留上游作者、来源、许可证、说明与依赖元数据。可访问或标注许可证不等于所有附带资源均已授予再分发许可；维护者需按各包实际许可证保留声明、提供必要源码/获取方式，并处理授权和下架请求。

## 官方参考

- [EdgeOne CLI 与 CI/CD](https://pages.edgeone.ai/zh/document/edgeone-cli)
- [Edge Functions](https://pages.edgeone.ai/zh/document/edge-functions)
- [套餐配额](https://pages.edgeone.ai/zh/document/billing-plan-comparison)
- [域名与访问限制](https://pages.edgeone.ai/zh/document/domain-overview)
- [GitHub 计划任务事件](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)
