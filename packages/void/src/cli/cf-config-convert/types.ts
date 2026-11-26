// Lifted from @cloudflare/codemods 0.8.2 (workers-sdk, packages/codemods/src/codemods/wrangler-to-cf),
// Copyright (c) Cloudflare, Inc., MIT licensed. Void translates Wrangler-format settings to the
// cf format in process with it. Keep changes minimal so that it can be compared with upstream;
// `cf-config-convert.test.ts` checks it against the installed codemod.
export type MigrationBundler = 'vite' | 'wrangler';

export interface WranglerToCfMigrationOptions {
  bundler?: MigrationBundler;
  dryRun?: boolean;
  force?: boolean;
  /** Whether to install cf and install or upgrade Vite plugin and Wrangler dependencies when needed. Required dependency changes become blocking follow-ups when false. */
  installDependencies?: boolean;
}

export interface MigrationFollowUp {
  blocking: boolean;
  code: string;
  docsUrl?: string;
  message: string;
  sourcePath?: string;
}

export interface WranglerToCfMigrationResult {
  changedFiles: Array<string>;
  followUps: Array<MigrationFollowUp>;
  requiresInstall: boolean;
  status: 'complete' | 'needs-intervention';
}

export interface OutputComment {
  docsUrl?: string;
  message: string;
}

export interface OutputObject {
  kind: 'object';
  properties: Array<OutputProperty>;
  trailingComments?: Array<OutputComment>;
}

export interface OutputCall {
  args: Array<OutputValue>;
  callee: string;
  kind: 'call';
}

export interface OutputProperty {
  comments?: Array<OutputComment>;
  key: string;
  value: OutputValue;
}

export type OutputValue =
  | boolean
  | null
  | number
  | string
  | OutputCall
  | OutputObject
  | Array<OutputValue>;

export interface ConvertedBranch {
  config: OutputObject;
  previewConfig?: OutputObject;
}

export interface ConvertedWranglerConfig {
  base: ConvertedBranch;
  environments: Map<string, ConvertedBranch>;
  followUps: Array<MigrationFollowUp>;
  imports: Set<string>;
  toolingBase?: ConvertedBranch;
  toolingEnvironments: Map<string, ConvertedBranch>;
}
