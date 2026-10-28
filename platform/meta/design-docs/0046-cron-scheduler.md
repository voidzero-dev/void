---
title: Platform Cron Scheduler
status: implemented
---

# Platform cron scheduler

The platform keeps project schedules in a CronScheduler Durable Object.
Deployment synchronizes the configured schedules; removal and rollback
reconcile the scheduler with the active deployment. Fired jobs are delivered
through the platform's queue path to the appropriate application Worker.

The scheduler separates timing from deployment and request serving. It also
allows the platform to manage many project schedules without creating a
Cloudflare Cron Trigger for every tenant job. The implementation is in
[CronScheduler](../../packages/api/src/cron-scheduler.ts); application
syntax is in the [jobs guide](../../../docs/en/guide/jobs.md).
