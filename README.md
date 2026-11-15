# dsh-caddy-login

DeepSeek Harness 的 Caddy 账号密码入口。浏览器弹出原生账号密码框，验证通过后，由 Caddy 在服务器端使用 DSH 当前进程令牌建立浏览器会话。

支持 DSH 0.2.2-rc.1、Node.js 24、Linux systemd 与 Caddy 2.11。DSH 保持监听本机 3080，公网 HTTPS 由已有 Caddy 站点提供。

## 安装

使用 Node.js 24 环境执行下面的命令。

```sh
dsh plugin --profile web add https://github.com/yangquan0310/dsh-caddy-login/releases/download/v0.1.1/dsh-caddy-login-0.1.1.tgz
```

安装包自动添加插件条目。首次安装时 username 为空，填写配置后启用。

在 ~/.dsh/profiles/web/cordis.patch.yml 中添加或修改以下条目。

```yaml
- id: dsh-caddy-login
  config:
    username: yangquan0310
    password: CADDY_LOGIN_PASSWORD
```

在 ~/.dsh/.env 中设置凭据。

```dotenv
CADDY_LOGIN_PASSWORD=替换为实际密码
```

password 是 DSH Credentials 凭据名称。插件通过 credentials.resolve() 读取，由 dsh-credentials-local 提供 .env 凭据。支持单行密码，修改凭据后最长约 15 秒更新。运行期间删除凭据会将该站点切换为 HTTP 503，恢复凭据后重新启用。

## Caddy 与运行权限

启用前应已有一个与 DSH public URL 相同 origin 的单地址 HTTPS 站点，例如 https://101.43.20.69:19857。插件从 webApp.getAdvertisedUrl() 读取公网 URL，保留该 URL 的路径前缀及原站点 TLS 配置。

插件用带标记的 import 替换此 HTTPS 站点，其余站点和全局配置保留。插件生成完整的账号密码反向代理配置，原 HTTPS 站点的其他自定义指令在插件启用期间由生成配置接管。

DSH 进程需要读取和写入 /etc/caddy/Caddyfile、/etc/caddy/dsh-caddy-login/、/var/lib/dsh-caddy-login/，并执行 caddy validate、caddy hash-password、id -g caddy 和 systemctl restart caddy.service。适用于已有 root 身份 DSH 服务及 caddy 用户的部署。

每次更新先校验候选配置，成功后以文件事务写入并重启 Caddy。短暂重连可能发生。失败时恢复之前的文件并重启原配置。原站点备份保存在 /var/lib/dsh-caddy-login/original-site-*.caddy。正常停用插件时恢复原站点。强制结束进程后，下一次插件启动处理事务日志并更新令牌。

生成片段包含 DSH 进程令牌，权限为 root:caddy 0640。事务状态和备份目录权限为 0700。禁止公开这些文件。密码以 bcrypt 哈希写入 Caddy，子进程通过标准输入接收密码。

检测到管理片段或 import 标记被外部修改时，自动更新和恢复会中止，错误记录在 DSH 插件日志中。恢复外部修改前请保留原文件和状态目录。

可选配置如下。

| 字段 | 默认值 |
| --- | --- |
| publicUrl | DSH 配置的公网 URL |
| caddyfile | /etc/caddy/Caddyfile |
| stateDirectory | /var/lib/dsh-caddy-login |
| refreshIntervalMs | 15000，最小 1000 |

## 开发验证

```sh
npm install
npm run check
CADDY_TEST_BINARY=/usr/bin/caddy npm test
npm pack
```

设置 CADDY_TEST_BINARY 后运行真实 Caddy HTTPS 测试，覆盖根路径和子路径、正确及错误密码、服务端令牌交换、Cookie 路径、过期会话恢复、Authorization 清除及 WebSocket 升级。
