# 超级管理员在 CI/CD 中的安全配置

目标：在自动部署时确保系统中始终只有一个超级管理员账号，同时避免把明文密码写进仓库。

## 1. 原则

- 不要把 `SPARKX_SUPER_PASSWORD` 写入任何 git 文件。
- 优先使用 `SPARKX_SUPER_PASSWORD_HASH`（MD5 32 位 hex，小写）替代明文密码。
- 只在需要“初始化/重置超级管理员”时配置这些变量；不需要时可以留空。

## 2. GitHub Actions Secrets（推荐）

在 GitHub 仓库 Settings → Secrets and variables → Actions → Secrets 中新增：

- `SPARKX_SUPER_EMAIL`：超级管理员邮箱（登录账号）
- `SPARKX_SUPER_USERNAME`：可选，展示名
- 二选一：
  - `SPARKX_SUPER_PASSWORD_HASH`：推荐，32 位 MD5 hex
  - `SPARKX_SUPER_PASSWORD`：不推荐，明文密码

> 注意：如果同时提供 `SPARKX_SUPER_PASSWORD_HASH` 与 `SPARKX_SUPER_PASSWORD`，服务端会优先使用 `SPARKX_SUPER_PASSWORD_HASH`。

CI/CD 部署流程会把这些 Secrets 作为环境变量注入到 `docker compose`，并由 service 容器在启动时完成：
- 确保 `users.is_super` 字段存在
- 将当前 `SPARKX_SUPER_EMAIL` 对应用户设置为 `is_super = 1`
- 将所有其他 `is_super = 1` 的用户降级为 `0`
- 覆盖更新该账号密码（用 hash 或明文计算 hash）

## 3. 服务器侧 .env（可选）

如果你不想在 GitHub Actions 里配置，也可以在远端部署目录（包含 `docker-compose.yml` 的目录）放一个 `.env`：

```env
SPARKX_SUPER_EMAIL=admin@example.com
SPARKX_SUPER_PASSWORD_HASH=<32-char-md5-hex>
SPARKX_SUPER_USERNAME=admin
```

然后 `docker compose up -d` 时会自动注入到 service 容器。

## 4. 风险提示

- 任何能查看容器环境变量的人（拥有服务器 docker 权限）都可能读取这些值。
- 即使使用 `SPARKX_SUPER_PASSWORD_HASH`，它仍然等价于登录凭据，应视为敏感信息并妥善管理。

