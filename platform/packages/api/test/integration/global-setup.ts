export default async function setup(): Promise<void> {
  // The public package setup runs first; defer imports that use those exports until then.
  const { ensurePGliteTemplateBundlePath } = await import('./db-template.ts');
  await ensurePGliteTemplateBundlePath();
}
