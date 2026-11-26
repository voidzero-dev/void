import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { createPlatformResourceOwnershipMarker } from '@void/platform';
import type { InstallationResource, PlatformInstallationManifest } from '@void/platform';
import { note } from '@voidzero-dev/vite-plus-prompts';
import { expect, vi } from 'vite-plus/test';
import {
  promoteInstallationSecrets,
  writeInstallationManifest,
  writePendingInstallationSecrets,
} from '../../src/cli/platform-registry.ts';

/** Saves the installation and its recovery secrets in a new registry directory added to `directories`. */
export function persistInstallation(
  manifest: PlatformInstallationManifest,
  directories: Array<string>,
): void {
  const directory = mkdtempSync(join(tmpdir(), 'void-platform-installation-test-'));
  directories.push(directory);
  process.env.VOID_PLATFORM_REGISTRY_DIR = directory;
  writeInstallationManifest(manifest);
  writePendingInstallationSecrets(manifest, { databaseUrl: 'postgres://recovery' });
  promoteInstallationSecrets(manifest);
}

export function ownershipMarker(
  manifest: Pick<PlatformInstallationManifest, 'account' | 'id' | 'ownershipNonce'>,
  resource: Pick<InstallationResource, 'id' | 'key' | 'kind' | 'name'>,
): string {
  return JSON.stringify(
    createPlatformResourceOwnershipMarker({
      accountId: manifest.account.id,
      installationId: manifest.id,
      ownershipNonce: manifest.ownershipNonce,
      resourceId: resource.id,
      resourceKey: resource.key,
      resourceKind: resource.kind,
      resourceName: resource.name,
    }),
  );
}

/** The last note shown under `title`. The calling test file must mock `note`. */
export function noteText(title: string): string {
  return String(
    vi
      .mocked(note)
      .mock.calls.filter(([, noteTitle]) => stripVTControlCharacters(noteTitle ?? '') === title)
      .at(-1)?.[0] ?? '',
  );
}

export function expectInOrder(text: string, lines: ReadonlyArray<string>): void {
  const positions = lines.map((line) => text.indexOf(line));
  expect(
    positions.map((position, index) => [lines[index], position >= 0]),
    text,
  ).toEqual(lines.map((line) => [line, true]));
  expect(positions, text).toEqual([...positions].sort((left, right) => left - right));
}
