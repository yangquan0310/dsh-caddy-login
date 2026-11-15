# dsh-caddy-login

本目录归属 DSH Caddy 账号密码登录插件。执行和协调由当前 Codex 负责，独立核查由最终代码审查代理负责，接收者为用户。

- 用户已确定配置位于 `~/.dsh/profiles/web/cordis.patch.yml`，字段为 `username`、`password`。`password` 是凭据名称，通过 DSH Credentials 服务读取 `~/.dsh/.env`。
- 公网入口为 Caddy HTTPS 19857，本机 DSH 为 127.0.0.1:3080。
- 当前实现允许写入本目录。生产配置启用及真实密码输入单独验收。
- 状态统一登记于 PLANS.md，目标和输入约定见 GOALS.md，可复用任务单见 PROMPTS.md。
- 原生 Node 测试覆盖认证入口、令牌更新、配置回滚及释放。禁止将密码、令牌或 Cookie 写入日志。
- 删除文件移动到回收站。备份保留至用户签收。
