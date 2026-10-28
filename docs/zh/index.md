---
layout: home
theme: dark
hero:
  name: Void
  text: 用 Vite 构建，用 Void 部署。
  tagline: Void 集 CLI、平台和全栈 SDK 于一身，将应用的构建与部署整合到同一个流程中。
  actions:
    - theme: brand
      text: 开始使用
      link: /zh/guide/
    - theme: alt
      text: 在 GitHub 上查看
      link: 'https://github.com/voidzero-dev/void'
    - theme: alt
      text: 阅读发布公告
      link: 'https://blog.cloudflare.com/deploy-with-void'
features:
  - iconify: 'lucide:layers'
    visual: stack
    title: 全栈功能，自动推断
    details: 按需导入功能，Void 会在本地提供所需资源，并在部署时创建对应资源。
    highlights:
      - 服务端路由与身份验证
      - 数据库、存储与 AI
      - 队列与定时任务
    guide:
      text: 了解 SDK
      link: /zh/guide/
  - iconify: 'lucide:wand-sparkles'
    visual: resources
    title: 从数据库到 UI，类型贯通
    details: 在数据库、服务端 loader 和页面组件之间共享类型。
    highlights:
      - 根据数据库 schema 推断类型
      - 带类型的 loader、action 和 API
      - 服务端代码仅在服务端运行
    guide:
      text: 了解类型安全
      link: /zh/guide/type-safety
  - iconify: 'lucide:blocks'
    visual: frameworks
    title: 使用你熟悉的框架
    details: 使用 Void 提供的适配器，也可以继续使用现有的 Vite 框架。
    highlights:
      - 内置 Async React、Vue、Svelte 和 Solid 适配器
      - 支持 TanStack Start、SvelteKit、Nuxt 等框架
      - 构建 API、SPA 或服务端渲染页面
    guide:
      text: 了解框架集成
      link: /zh/integrations/frameworks/overview
platform_features:
  - id: platform-ai-coding
    iconify: 'lucide:bot'
    title: 让团队安全地用 AI 开发
    details: 团队成员可以借助编程 Agent 构建和部署应用，Cloudflare 的访问权限仍由管理员掌控。
    highlights:
      - 让非技术同事也能构建自己的应用
      - Cloudflare 凭据由管理员团队保管
      - 快速部署原型，分享应用并收集反馈
    guide:
      text: 了解团队部署
      link: /zh/guide/self-hosted-platform
    visual: rive
    image_alt: 团队构建应用的动画示意
  - id: platform-control-plane
    iconify: 'lucide:panels-top-left'
    visual: resources
    title: 统一管理应用的控制平面
    details: 通过管理界面或 CLI 管理用户、项目和部署，并查看平台健康状况。
    highlights:
      - 管理用户、项目访问权限和资源
      - 查看部署、日志和回滚
      - 监控平台健康状况和用量
    guide:
      text: 平台管理
      link: /zh/guide/platform-administration
    image_alt: 用于访问权限、构建、邀请和管理的 Void 平台命令列表
  - id: platform-security
    iconify: 'lucide:shield-check'
    title: 按团队标准定制安全策略
    details: Fork 并定制自己的 Void 平台，满足团队的安全要求。
    highlights:
      - 通过 Cloudflare Access、Google、GitHub 或 OIDC 管理访问
      - 控制谁可以登录和部署
      - 通过访问策略保护项目
    guide:
      text: 配置平台访问权限
      link: /zh/guide/platform/administration/access
    visual: rive
    image_alt: 自托管平台安全机制的动画示意
footer_heading: 用 Vite 构建，用 Void 部署。
footer_subheading: 服务端代码、资源与部署，整合在同一个流程中。
homeI18n:
  hero_by: 出品方
  hero_animation_label: Vite 应用转变为 Void 应用的动画
  get_started: 开始使用
  platform_link: /zh/guide/self-hosted-platform
  platform_label: 自托管 Void 平台指南
  platform_heading: 部署时，安全策略一并到位
  platform_description: 自托管团队的 Void 平台，并按团队的安全要求定制。
  sdk_link: /zh/guide/
  sdk_label: Void SDK 指南
  sdk_heading: 让 Vite 应用拥有全栈能力
  sdk_description: 使用你熟悉的 Vite 框架，按需添加后端功能，其余资源由 Void 自动推断。
  cli_link: /zh/reference/cli
  cli_label: Void CLI 参考
  cli_heading: 一条命令，完成部署
  cli_description: 从构建、部署到资源管理，覆盖项目的整个生命周期。
  cli_commands_label: Void CLI 命令
  pause_demo: 暂停演示
  replay_demo: 重播演示
  play_demo: 播放演示
  cli_demos:
    deploy:
      label: 部署应用
      description: 构建应用、执行迁移，并将应用部署到 Cloudflare。一条命令即可完成。
      context: >-
        带服务端路由和 D1 的 React 应用，已经直接部署到 Cloudflare。Cloudflare
        是已保存的部署目标；登录和数据库配置已准备就绪。演示精简了构建输出。
    install:
      label: 安装平台
      description: 在自己的 Cloudflare 账号中，为团队提供共享部署环境。
      context: >-
        Orange Cloud 安装示例，凭据输入已隐藏。Cloudflare 登录、PostgreSQL/Hyperdrive 和
        GitHub/R2 配置已准备就绪；管理员身份、客户端和访问 ID，以及签名和加密密钥在录制之外提供。安装输出和演示时间经过精简。
    recover:
      label: 日志与回滚
      description: 在终端中查看失败的请求，并恢复到之前的部署。
      context: 已关联到 Orange Cloud 的项目。保留的上一版本部署使用相同的数据库 schema；回滚恢复代码，不会撤销数据库迁移。
  visuals:
    stack_description: Void 连接器的动画示意。
    frameworks_description: Void 框架集成的动画示意。
    frameworks_game_label: 框架集成与 Stack & Ship 游戏
  platform_commands_label: Void 平台命令
  resource_files_label: 资源示例文件
  game:
    play: 开始 Stack & Ship 游戏
    layer: 层
    layers: 层
    score: 得分
    best: 最佳
    close_aria: 关闭游戏
    drop_aria: '落下 {framework} 方块。轻触、按空格键或 Enter 键。'
    hint_before_key: 轻触或按
    hint_key: 空格
    hint_after_key: 落下
    pause_aria: 暂停游戏
    perfect: 完美
    new_best: '新纪录 · '
    shipped: '已叠好 {layers} {unit}。'
    restart: 再叠一摞
    share: 分享
    share_aria: 在 X 上分享成绩（在新标签页打开）
    paused: 已暂停 · 进度已保留
    resume: 继续堆叠
  terminal_example: 动画示例：
  terminal_transcript: 播放器后附有完整的文字记录。
---

<script setup>
import Home from '../.vitepress/theme/Home.vue'
</script>

<Home />
