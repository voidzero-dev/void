import { prepareFixture, type FixtureApp } from './fixture-app.ts';

const [framework, name] = process.argv.slice(2);
if (!['react', 'vue', 'svelte', 'solid'].includes(framework ?? '') || !name) {
  throw new Error('Usage: node test/prepare-fixture.ts <framework> <fixture>');
}
const { fixtures }: { fixtures: Readonly<Record<string, FixtureApp>> } = await import(
  `./fixtures/${framework}.ts`
);
if (!Object.hasOwn(fixtures, name)) {
  throw new Error(`Unknown ${framework} fixture: ${name}`);
}
prepareFixture(fixtures[name]!);
