import type { PlatformPlanCatalog } from '@void/platform/plans';
import type { PlanAiLoggingSettings } from '../ai-logging-policy.ts';
import type { PlanCatalogAction } from '../operator/plans.ts';

export type AdminPlanPreview = {
  action: PlanCatalogAction;
  target: string;
  body: Record<string, unknown>;
  expectedRevision: number;
  before: PlatformPlanCatalog;
  after: PlatformPlanCatalog;
  /** Plan AI logging defaults before and after the change. */
  aiLoggingBefore: PlanAiLoggingSettings['modes'];
  aiLoggingAfter: PlanAiLoggingSettings['modes'];
  affectedAccounts: number;
  warnings: Array<string>;
  overLimitAccounts: Array<{ id: string; login: string; reasons: Array<string> }>;
  usageSampleSize: number;
};

/** Progress of account updates and the AI logging publish, combined. */
export type AdminPlanProgress = {
  revision: number;
  complete: boolean;
  /** Accounts plus projects written by this step; zero means it made no progress. */
  processed: number;
  /** Accounts whose limits were updated by this step. */
  accounts: number;
  /** Projects whose AI logging setting was published by this step. */
  projects: number;
  /** Changes whenever either step moves, so the page can tell it is not stuck. */
  cursor: string | null;
  error: string | null;
};
