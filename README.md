# SparkPlay

## 平台愿景

释放每一份创意，让游戏创作归于简单

## 平台能力

- 项目管理：创建/打开项目，管理版本与构建产物
- 资源管理：统一管理文本、图片、音频、视频等资源及其版本
- 工程协作：面向工程结构的可视化编辑与迭代
- Agent 辅助：结合智能体与模型能力，辅助代码与资产生成
- 游戏发布与预览：一键构建发布包，并支持平台预览验证（Web/移动端）

## 项目文件结构

```text
SparkPlay/
├── .github/                 # CI/CD（GitHub Actions）
├── design/                  # 平台设计文档与数据表拆分索引
├── deploy/                  # 部署配置（docker-compose）
├── scripts/                 # 仓库管理脚本
├── web_api/                 # 接口文档服务（Swagger UI，Docker 构建入口）
├── repos.yaml               # 仓库配置文件（替代 git submodules）
└── README.md
```

> **注意**：本项目使用 `repos.yaml` + 脚本管理依赖仓库，不再使用 Git Submodules。
> 相关仓库（agents, service, skills, web, web_admin）通过 [repos.yaml](repos.yaml) 配置，使用 [scripts/fetch_repos.py](scripts/fetch_repos.py) 拉取。
>
> **子仓库目录**（通过脚本拉取）：
> - `web/` - 前端 Web 应用（用户端编辑器/工作台）
> - `service/` - 后端服务 API（Go-zero 框架）
> - `agents/` - AI Agent 代码生成模块
> - `skills/` - 项目技能模块
> - `web_admin/` - 管理后台前端（运营/管理员使用）

项目数据表设计索引：`design/SparkX_Table_Design.md`

## .github（CI/CD）

当前仓库包含一个 GitHub Actions 工作流：`.github/workflows/aliyun-acr-build-deploy.yml`，用于：

- 在 `main/master` 分支 push 时构建 Docker 镜像并推送到阿里云 ACR
- 在构建完成后，通过 SSH 将 `deploy/docker-compose.yml` 分发到服务器并执行 `docker compose pull/up`

工作流要点：

- 不再使用 git submodules，依赖仓库通过 `repos.yaml` 管理
- 仅对存在 `Dockerfile` 的组件执行构建（当前 `web_api/` 有 `Dockerfile`）
- 会将 `mysql:8.4` 镜像同步到 ACR，供部署时使用

需要配置的 Secrets（Settings → Secrets and variables → Actions）：
- `ALIYUN_ACR_REGISTRY` / `ALIYUN_ACR_NAMESPACE` / `ALIYUN_ACR_USERNAME` / `ALIYUN_ACR_PASSWORD`：ACR 登录信息
- `ALIYUN_DEPLOY_SSH_PRIVATE_KEY`：用于登录部署服务器的 SSH 私钥
- `ALIYUN_DEPLOY_HOST` / `ALIYUN_DEPLOY_USER`：部署服务器地址与用户
- `ALIYUN_DEPLOY_DIR`：远端部署目录（可选，默认 `sparkx`）

## deploy（部署）

`deploy/docker-compose.yml` 当前包含：

- `web`：`ACR_REGISTRY/ACR_NAMESPACE/sparkplay-web:${WEB_TAG:-latest}`，默认映射 `80 -> 3000`
- `mysql`：默认 `mysql:8.4`，也支持通过 `MYSQL_IMAGE` 指定 ACR 内镜像

常用环境变量：

- `ACR_REGISTRY`、`ACR_NAMESPACE`：镜像仓库地址与命名空间（使用私有 ACR 时必填）
- `WEB_TAG`、`WEB_PORT`：Web 镜像 tag 与对外端口
- `MYSQL_IMAGE`、`MYSQL_DATABASE`、`MYSQL_USER`、`MYSQL_PASSWORD`、`MYSQL_ROOT_PASSWORD`、`MYSQL_PORT`
- `SPARKX_SUPER_EMAIL`、`SPARKX_SUPER_PASSWORD_HASH`（推荐）/`SPARKX_SUPER_PASSWORD`、`SPARKX_SUPER_USERNAME`：用于部署时初始化/覆盖超级管理员（见 `deploy/SUPER_ADMIN.md`）

在服务器上手动部署/更新（示例）：

```bash
cd /path/to/deploy-dir
docker compose -f docker-compose.yml pull
docker compose -f docker-compose.yml up -d --remove-orphans
```

## 仓库管理

本项目使用 `repos.yaml` 配置文件管理依赖仓库，替代了传统的 Git Submodules。

### 配置文件

[repos.yaml](repos.yaml) 定义了所有依赖仓库的信息：

```yaml
repositories:
  - name: skills
    path: skills
    url: https://github.com/anil-wu/skills.git
    branch: main

  - name: agents
    path: agents
    url: https://github.com/anil-wu/metai-game-code-agent.git
    branch: main

  - name: service
    path: service
    url: git@github.com:anil-wu/sparkx-service.git
    branch: feature/login
```

### 拉取仓库

使用 Python 脚本管理依赖仓库：

```bash
# 克隆/更新所有仓库
python scripts/fetch_repos.py

# 查看帮助信息
python scripts/fetch_repos.py --help

# 仅克隆/更新指定仓库
python scripts/fetch_repos.py --repo service

# 查看所有仓库状态
python scripts/fetch_repos.py --status

# 强制重新克隆（会删除已存在的目录）
python scripts/fetch_repos.py --force
```

### 依赖仓库说明

根据 [repos.yaml](repos.yaml) 配置，项目包含以下依赖仓库：

| 仓库名 | 路径 | 说明 |
|--------|------|------|
| skills | `skills/` | 项目技能模块 |
| agents | `agents/` | AI Agent 代码生成模块 |
| web | `web/` | 前端 Web 应用 |
| service | `service/` | 后端服务 API |
| web_admin | `web_admin/` | 管理后台前端（运营/管理员使用） |

### 从 Git Submodules 迁移

如果你之前使用 Git Submodules，已经执行了以下清理：
- 删除了 `.gitmodules` 文件
- 从 Git 缓存中移除了子模块
- 提交了变更

现在只需运行上述脚本即可拉取独立仓库。
