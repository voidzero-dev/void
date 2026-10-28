---
layout: home
theme: dark

hero:
  name: Void
  text: Build with Vite. Deploy with Void.
  tagline: Void is a CLI, platform, and full-stack SDK that unifies building & deploying apps.
  actions:
    - theme: brand
      text: Get Started
      link: ./guide/
    - theme: alt
      text: View on GitHub
      link: https://github.com/voidzero-dev/void
    - theme: alt
      text: Read the Announcement
      link: https://blog.cloudflare.com/deploy-with-void
features:
  - iconify: lucide:layers
    visual: stack
    title: Full-Stack, Inferred
    details: Import what you need. Void provides local resources and provisions them on deploy.
    highlights:
      - Server routes and authentication
      - Databases, storage, and AI
      - Queues and scheduled jobs
    guide:
      text: Explore the SDK
      link: /guide/
  - iconify: lucide:wand-sparkles
    visual: resources
    title: Typed from Database to UI
    details: Share types across your database, server loaders, and page components.
    highlights:
      - Types from your database schema
      - Typed loaders, actions, and APIs
      - Server code stays on the server
    guide:
      text: Explore Type Safety
      link: /guide/type-safety
  - iconify: lucide:blocks
    visual: frameworks
    title: Use Your Favorite Framework
    details: Build with Void's adapters or keep your existing Vite framework.
    highlights:
      - Ships with adapters for Async React, Vue, Svelte, and Solid
      - Supports TanStack Start, SvelteKit, Nuxt, and more
      - Build APIs, SPAs, or server-rendered pages
    guide:
      text: Explore Frameworks
      link: /integrations/frameworks/overview
platform_features:
  - id: platform-ai-coding
    iconify: lucide:bot
    title: Secure Vibe Coding for Your Team
    details: Let your team build and deploy with coding agents while admins retain control of Cloudflare access.
    highlights:
      - Enable non-technical teammates to build their own apps
      - Keep Cloudflare credentials with your admin team
      - Deploy prototypes fast and share apps for feedback
    guide:
      text: Explore team deployments
      link: /guide/self-hosted-platform
    visual: rive
    image_alt: Animated illustration of apps being built for a team
  - id: platform-control-plane
    iconify: lucide:panels-top-left
    visual: resources
    title: Control Plane for Managing Apps
    details: Manage users, projects, deployments, and platform health from the admin UI or CLI.
    highlights:
      - Manage users and project access & resources
      - Inspect deployments, logs, and rollbacks
      - Monitor platform health and usage
    guide:
      text: Platform administration
      link: /guide/platform-administration
    image_alt: List of Void platform commands for access, builds, invitations, and administration
  - id: platform-security
    iconify: lucide:shield-check
    title: Bring your Own Security
    details: Fork and customize your own Void platform based on your team's security standards.
    highlights:
      - Manage access through Cloudflare Access, Google, GitHub, or OIDC
      - Control who can sign in and deploy
      - Protect projects with your access policies
    guide:
      text: Configure platform access
      link: /guide/platform/administration/access
    visual: rive
    image_alt: Animated illustration of self-hosted platform security
footer_heading: Build with Vite. Deploy with Void.
footer_subheading: Server code, resources, and deployment in one workflow.
---

<script setup>
import Home from '../.vitepress/theme/Home.vue'
</script>

<Home />
