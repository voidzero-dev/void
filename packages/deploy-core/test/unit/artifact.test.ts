import { describe, expect, it } from 'vite-plus/test';
import {
  DEPLOY_ARTIFACT_VERSION,
  createDeployArtifact,
  createDeployUploadPayload,
  type DeployManifest,
} from '../../src/index.ts';

describe('deployment artifacts', () => {
  const manifest: DeployManifest = {
    version: 3,
    type: 'framework',
    framework: 'astro',
    bindings: { kv: ['CACHE'] },
    assetConfig: { not_found_handling: 'none' },
  };

  it('creates one versioned target-neutral artifact', () => {
    const artifact = createDeployArtifact({
      manifest,
      assetManifest: {
        '/index.html': { blake3: 'b3', md5: 'md5', size: 12, hash: 'b3' },
      },
      workerFiles: { 'index.js': 'ZXhwb3J0IGRlZmF1bHQge30=' },
    });

    expect(artifact).toEqual({
      artifactVersion: DEPLOY_ARTIFACT_VERSION,
      manifest,
      assetManifest: {
        '/index.html': { blake3: 'b3', md5: 'md5', size: 12, hash: 'b3' },
      },
      workerFiles: { 'index.js': 'ZXhwb3J0IGRlZmF1bHQge30=' },
    });
  });

  it('keeps target metadata outside the artifact and preserves the hosted wire shape', () => {
    const artifact = createDeployArtifact({ manifest, assetManifest: {} });
    const payload = createDeployUploadPayload(artifact, {
      source: 'cli',
      commit: 'abc123',
      repositoryUrl: null,
      commitUrl: null,
      gitRef: 'main',
      preflight: null,
    });

    expect(payload).toEqual({
      manifest,
      assetManifest: {},
      source: 'cli',
      commit: 'abc123',
      repositoryUrl: null,
      commitUrl: null,
      gitRef: 'main',
      preflight: null,
    });
    expect(payload).not.toHaveProperty('artifactVersion');
  });

  it('names uploaded Worker modules by workerInput instead of carrying their bytes', () => {
    const metadata = {
      source: 'cli',
      commit: null,
      repositoryUrl: null,
      commitUrl: null,
      gitRef: null,
      preflight: null,
    };
    const workerInput = {
      id: 'upload-1',
      modules: [{ name: 'index.js', size: 18, sha256: 'a'.repeat(64) }],
    };
    const payload = createDeployUploadPayload(
      createDeployArtifact({ manifest, assetManifest: {} }),
      metadata,
      workerInput,
    );

    expect(payload.workerInput).toEqual(workerInput);
    expect(payload).not.toHaveProperty('workerFiles');
    expect(() =>
      createDeployUploadPayload(
        createDeployArtifact({
          manifest,
          assetManifest: {},
          workerFiles: { 'index.js': 'ZXhwb3J0IGRlZmF1bHQge30=' },
        }),
        metadata,
        workerInput,
      ),
    ).toThrow('not both');
  });
});
