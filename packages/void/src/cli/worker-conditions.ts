// workerd's conditions, then a browser build's, so packages pick their Worker builds.
export const WORKER_CONDITIONS: Array<string> = [
  'workerd',
  'worker',
  'browser',
  'module',
  'import',
  'default',
];
