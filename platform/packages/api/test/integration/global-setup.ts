import { ensurePGliteTemplateBundlePath } from './db-template.ts';

export default async function setup(): Promise<void> {
  await ensurePGliteTemplateBundlePath();
}
