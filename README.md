# CesiumLoader 市场镜像

每天同步上游 Forge 的模组目录、全部已发布版本 ZIP、封面与贴纸资源；ZIP 保持原始字节并核对 SHA-256。同步与检查成功后，GitHub Actions 会把 `public/`、`generated/` 提交回公开仓库，供下载或日后部署。

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

## GitHub Actions 每日同步

每次默认执行 `npm ci → npm run sync → npm test → npm run build → 提交 public/generated → 上传 artifact`。所有步骤成功后，机器人仅暂存 `public/`、`generated/`；有改动才创建 `chore: sync CesiumLoader market snapshot` 提交，并在 `git pull --rebase` 成功后推送到 `main`，不强制推送。同步、校验或变基冲突会令执行失败，不把不完整快照提交到远端。

仓库的 [public](https://github.com/Thisisseanxu/CesiumLoader-market-mirror/tree/main/public) 目录包含原始 ZIP、封面和贴纸，[generated](https://github.com/Thisisseanxu/CesiumLoader-market-mirror/tree/main/generated) 包含 API 快照。工作流对这两个目录的单独推送设置了 `paths-ignore`，避免递归触发；同步提交不添加跳过 CI 的标记，以便 EdgeOne 接收 Git 更新并自动部署。

在 Actions 运行记录的 **Artifacts** 区域，也可下载 `cesiumloader-market-mirror-<运行编号>`，取得快照、镜像文件、函数代码及构建配置；artifact 保留 7 天。Git 提交中的文件不会因为 artifact 到期而删除。Actions 负责同步和提交，EdgeOne 通过原生 Git 集成构建部署。

计划为 UTC `19:30`，即北京时间次日 `03:30`，每天一次。GitHub 的计划任务可能排队延迟，不保证准点触发；计划仅在默认分支运行，公开仓库长期无活动可能被 GitHub 自动停用。可在 Actions 页面使用 **Run workflow** 手动恢复或补跑。

Actions 使用仓库自带的 `GITHUB_TOKEN` 和 `contents: write` 权限提交，不需要配置额外的 GitHub Token 或任何 EdgeOne Secret。若开启分支保护，需允许机器人按仓库规则写入 `main`，否则推送会失败；工作流不会绕过保护或强制覆盖提交。

Actions 缓存用于减少重复下载，缓存缺失时仍会校验并补齐全部版本。GitHub Actions 的运行时间、缓存及 artifact 配额由 GitHub 单独计算，不包含在 Makers 免费额度内。ZIP 的版本变化会增加 Git 历史体积，需根据长期使用情况维护仓库。

## EdgeOne Makers Git 自动部署

创建名为 `cesiumloader-market-mirror` 的 Git 项目（平台项目名仅支持小写），连接此仓库的 `main` 分支，根目录为仓库根目录，安装命令为 `npm ci`，构建命令为 `npm run build`，输出目录为 `public`，Node.js 版本为 `22.22.0`。EdgeOne 构建使用仓库中的已校验快照，不会再次联网同步模组。

项目不需要业务密钥或运行时环境变量。GitHub 仓库变量 `FORGE_UPSTREAM` 控制同步上游地址，默认 `https://forge.hiynet.com`；EdgeOne 构建环境使用 `NODE_ENV=production` 和上述 Node.js 版本。无需在 GitHub Actions 配置 EdgeOne API Token。
