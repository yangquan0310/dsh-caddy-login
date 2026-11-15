# 实施计划与状态

执行者和协调人：当前 Codex。独立核查人：最终代码审查代理。接收者：用户。
输入版本及配置约定已在 GOALS.md 签收。允许写入范围为本目录。

| 任务 | 前置条件 | 交付与验收 | 状态 |
|---|---|---|---|
| T1 接口与配置事务 | 用户确认设计 | 配置生成、校验、回滚、所有权、外部修改与跨进程锁测试通过 | 已验收 |
| T2 插件生命周期 | T1 验收 | 凭据解析、令牌刷新、缺失凭据及释放竞争测试通过 | 已验收 |
| T3 可安装包 | T2 验收 | bundle patch、README、npm pack 已生成，等待服务器安装验收 | 进行中 |
| T4 独立核查与交付 | T3 验收 | 独立核查及返工复核通过，等待发布与生产验收 | 待核查 |

## 执行步骤

- T1 先验证坏配置、外部修改、并发事务、失败回滚及恢复的失败测试，再实现最小事务管理器。
- T2 验证缺失凭据拒绝激活、捕获并隐藏启动令牌、重复启动及释放竞争，再接入指定版本插件接口。
- T3 验证正确账号密码、错误密码、过期 DSH Cookie 自动恢复和 WebSocket，校验安装包内容。
- T4 新上下文审查全部变更，修复重要缺陷，重跑完整测试并记录验收。

## 证据与决定

- 工作区为本目录，相对路径和校验值随任务完成登记。
- 2026-11-15 用户指定项目目录 C:/Users/yangq/OneDrive/Documents/PluginDevelopment/dsh-caddy-login，项目文档已迁移。
- 已核对 npm 发布的 0.2.2-rc.1。采用 connection.authenticatedUrl()、webApp.getAdvertisedUrl()、credentials.resolve()。当前主分支的 webserver/entry-url 事件不适用于本次版本。
- 规划按项目现有文档要求合并登记在本文件，执行由当前代理持续推进，最终交独立代理核查。
- 用户确认公开发布到 yangquan0310/dsh-caddy-login，并通过 dsh 插件命令安装。
- 基线提交 2eb1366，任务分支 task/caddy-login，修改分支 feat/password-login，目录 .worktree/password-login。工作树工具请求未完成，核对无新增工作树后使用 git worktree add 创建。
- 独立核查人 review_caddy_login 发现候选校验期间外部修改覆盖、空锁恢复及并发接管锁竞态。先补充失败测试，修复后由同一核查人复核通过。
- 锁使用 Node 24 内置 SQLite 的 BEGIN EXCLUSIVE，进程结束由操作系统释放，无额外运行依赖。
- 已执行真实 Caddy 2.11.9 测试，包含根路径和前缀路径、正确及错误密码、原生会话交换、Cookie 失效恢复和 WebSocket。
- 服务器读取确认 DSH 服务使用 Node 24、127.0.0.1:3080 和既有 HTTPS 19857 路径，Caddy 用户组为 caddy。DSH_CADDY_PASSWORD 尚未设置，密码由用户亲自输入。

- v0.1.0 已公开发布并通过 dsh plugin --profile web add 安装成功。首次启用发现 DSH 禁止 .env 使用 DSH_ 前缀，已备份凭据并恢复服务。用户同意改用 CADDY_LOGIN_PASSWORD，v0.1.1 修正默认引用和说明，20 项测试通过。
