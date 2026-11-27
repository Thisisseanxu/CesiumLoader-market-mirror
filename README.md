# CesiumLoader 市场镜像

每天同步上游 Forge 的普通模组、资源包目录及其全部已发布版本、封面、预览图、安装清单与贴纸。在当前镜像 1 GB 上限内保留这些内容，ZIP 保持原始字节并核对 SHA-256。GitHub Actions 同步成功后提交 `public/`、`generated/`，EdgeOne Makers 通过 Git 集成自动部署；不提供网站页面。

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
| `/api/mods` | 普通模组列表；支持 `lang/query/tag/origin/sort/page/pageSize` |
| `/api/mods/{id}` | 详情与所有镜像版本 |
| `/api/mods/{id}/download?version=...` | 下载镜像 ZIP；省略版本取最新版本 |
| `/api/mods/{id}/cover` | 跳转到同源封面 |
| `/api/resources` | 资源包列表；在普通列表参数之外支持 `type`，保留 `types` 类型定义 |
| `/api/resources/{id}` | 资源包详情、预览图、依赖与各版本安装清单地址 |
| `/api/resources/{id}/download?version=...` | 下载资源包 ZIP；省略版本取最新版本 |
| `/api/resources/{id}/cover` | 跳转到同源资源包封面 |
| `/api/resources/{id}/previews/{sha256}` | 跳转到同源预览图 |
| `/api/resources/{id}/versions/{version}/manifest` | 跳转到同源安装清单 JSON |
| `/api/downloads/{sha256}.zip` | 将大包分片流式还原成原始 ZIP，支持 GET、HEAD、Range 与 ETag |
| `/api/sync-report` | 当前文件体积、预算与因容量跳过的条目 |
| `/api/stickers` | 贴纸目录 |
| `/api/mod-stickers?modIds=...` | 同步时的贴纸计数快照，`reactedByMe` 始终为 `false` |
| `POST /api/mod-stickers/{id}/reactions` | 返回 `405`；镜像只读，不接受回应写入 |

保留 `zh-Hans`、`zh-Hant`、`en`、`ja` 四种语言。下载统计与贴纸计数是同步时的上游快照，不代表镜像站实时统计。未知 API 返回 JSON 404，不回退到 HTML。

2026-11-27 核对的上游公开协议仍为 `apiVersion: 1`，已增加独立的 `/api/resources`，包括 `card_skin` 和 `audio_skin` 资源类型；普通模组与资源包的 `origin` 等原始元数据一并保留。

## 容量与大文件

当前镜像上限为 **1,000,000,000 字节（十进制 1 GB）**。同步器为函数和元数据预留 16 MiB，其余预算包含 ZIP／分片、封面、预览图、安装清单和贴纸。先按包大小筛选，再把实际附属资源计入预算，最后构建检查静态文件与函数源码总量。

超出预算时，先按全部版本 ZIP 合计大小，从大到小跳过资源包；仍然超限时，再从大到小跳过普通模组。跳过以整个条目为单位，包含其所有版本，四种语言的列表与详情同步隐藏；下一次同步会重新评估，容量允许即可恢复。`generated/sync-report.json` 和 `/api/health` 的 `syncReport` 记录跳过原因与大小。镜像下载接口不会将不存在的版本回退到上游下载。

每个静态文件最多 25,000,000 字节。超过此值的 ZIP 拆成 **20 MiB** 的 `.part` 文件，提交到 `public/chunks/`；完整大 ZIP 只保存在忽略的本地缓存中。下载 API 顺序读取同源分片，通过 Web Streams 输出原始 ZIP，支持跨分片断点续传，Toys 无需额外合并操作。同步时校验原包，构建时校验各分片及按顺序还原后的完整 SHA-256；任何缺片或截断均中止下载。

小 ZIP、图片与清单直接由静态服务提供，大 ZIP 的还原会调用 Edge Function；分片读取不访问上游。当前上限内的单包最多需要 47 个分片，低于 EdgeOne 单次函数 64 次 fetch 的限制。平台限制参见 [Edge Functions](https://pages.edgeone.ai/zh/document/edge-functions) 与 [Fetch](https://cloud.tencent.com/document/product/1552/81897)。

1 GB 仅限制当前镜像，不包含 Git 历史、GitHub Actions 缓存或 EdgeOne 历史部署。本项目不会自动删除这些历史数据。

## GitHub Actions 每日同步

每次默认执行 `npm ci → npm run sync → npm test → npm run build → 提交 public/generated → 上传同步报告`。所有步骤成功后，机器人仅暂存 `public/`、`generated/`；有改动才创建 `chore: sync CesiumLoader market snapshot` 提交，并在 `git pull --rebase` 成功后推送到 `main`，不强制推送。同步、校验或变基冲突会令执行失败，不把不完整快照提交到远端。

仓库的 [public](https://github.com/Thisisseanxu/cesium-market-mirror/tree/main/public) 目录包含 ZIP 或其分片以及其他镜像文件，[generated](https://github.com/Thisisseanxu/cesium-market-mirror/tree/main/generated) 包含 API 快照与同步报告。工作流对这两个目录的单独推送设置了 `paths-ignore`，避免递归触发；同步提交不添加跳过 CI 的标记，以便 EdgeOne 接收 Git 更新并自动部署。

Actions 只上传体积很小的 `mirror-sync-report-<运行编号>` 报告 artifact，保留 7 天，避免每天重复保存整份镜像。完整镜像保存在 Git 仓库，不受 artifact 到期影响。

计划为 UTC `19:30`，即北京时间次日 `03:30`，每天一次。GitHub 的计划任务可能排队延迟，不保证准点触发；计划仅在默认分支运行，公开仓库长期无活动可能被 GitHub 自动停用。可在 Actions 页面使用 **Run workflow** 手动恢复或补跑。

Actions 使用仓库自带的 `GITHUB_TOKEN` 和 `contents: write` 权限提交，不需要配置额外的 GitHub Token 或任何 EdgeOne Secret。若开启分支保护，需允许机器人按仓库规则写入 `main`，否则推送会失败；工作流不会绕过保护或强制覆盖提交。

Actions 缓存用于减少重复下载，缓存缺失时仍会校验并补齐全部版本。GitHub Actions 的运行时间、缓存及 artifact 配额由 GitHub 单独计算，不包含在 Makers 免费额度内。ZIP 的版本变化会增加 Git 历史体积，需根据长期使用情况维护仓库。

## EdgeOne Makers Git 自动部署

创建名为 `cesium-market-mirror` 的 Git 项目，连接 `Thisisseanxu/cesium-market-mirror` 的 `main` 分支，开启生产环境的自动部署，根目录为仓库根目录，框架选择 Other，安装命令为 `npm ci`，构建命令为 `npm run build`，输出目录为 `public`，Node.js 版本为 `22.21.1`。EdgeOne 构建使用仓库中的已校验快照，不会再次联网同步模组。根目录下的 `edge-functions/` 会与静态文件一起部署。

项目不需要业务密钥或自定义运行时环境变量，无需配置 `NODE_ENV` 和 `NODE_VERSION`。Node.js 版本由项目设置与 `edgeone.json` 指定，GitHub Actions 则读取 `.node-version`。

GitHub 仓库变量 `FORGE_UPSTREAM` 仅控制每日同步的上游地址，省略时仍使用默认值 `https://forge.hiynet.com`。无需将其配置到 EdgeOne，也无需在 GitHub Actions 配置 EdgeOne API Token。
