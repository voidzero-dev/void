import type { DeployManifest } from './index.ts';

export const DEPLOY_ARTIFACT_VERSION = 1 as const;

/** Content-addressed metadata for one static asset in a deployment artifact. */
export type DeployAssetManifestEntry = {
  blake3: string;
  md5: string;
  size: number;
  /** @deprecated v1 alias of `blake3`. */
  hash: string;
};

/** Target-neutral output of packaging a Void application for deployment. */
export type DeployArtifact = Readonly<{
  artifactVersion: typeof DEPLOY_ARTIFACT_VERSION;
  manifest: Readonly<DeployManifest>;
  assetManifest: Readonly<Record<string, Readonly<DeployAssetManifestEntry>>>;
  /** Worker module bytes keyed by relative path, base64-encoded for transport. */
  workerFiles?: Readonly<Record<string, string>>;
}>;

export type DeploySourceMetadata = {
  source: string | null;
  commit: string | null;
  repositoryUrl: string | null;
  commitUrl: string | null;
  gitRef: string | null;
};

/** One Worker module uploaded to R2 before the deployment is finalized. */
export type DeployWorkerModule = {
  /** Module path relative to the Worker output, the same key `workerFiles` uses. */
  name: string;
  /** Byte length of the module. */
  size: number;
  /** SHA-256 of the module bytes as 64 lowercase hex characters. */
  sha256: string;
};

/** Request body of `POST /projects/:id/deploy/worker-upload-urls`. */
export type DeployWorkerUploadRequest = {
  modules: Array<DeployWorkerModule>;
};

/** Upload URLs for each requested module, in request order. */
export type DeployWorkerUploadResponse = {
  id: string;
  urls: Array<{ url: string; headers: Record<string, string> }>;
};

/** Worker modules already uploaded through `worker-upload-urls`, named by its upload `id`. */
export type DeployWorkerInput = {
  id: string;
  modules: Array<DeployWorkerModule>;
};

/**
 * JSON payload accepted by the managed deployment API. Worker modules travel
 * either inline as `workerFiles` or uploaded beforehand as `workerInput`,
 * never both.
 */
export type DeployUploadPayload = {
  manifest: DeployManifest;
  assetManifest: Record<string, DeployAssetManifestEntry>;
  workerFiles?: Record<string, string>;
  workerInput?: DeployWorkerInput;
} & DeploySourceMetadata & {
    preflight: 'true' | null;
  };

/** Asset declaration accepted by the direct-upload URL endpoint. */
export type DeployAssetUploadRequest = {
  blake3: string;
  md5: string;
  size: number;
  contentType: string;
};

/** Build one target-neutral artifact before either target adds provider state. */
export function createDeployArtifact(input: {
  manifest: DeployManifest;
  assetManifest: Record<string, DeployAssetManifestEntry>;
  workerFiles?: Record<string, string>;
}): DeployArtifact {
  return {
    artifactVersion: DEPLOY_ARTIFACT_VERSION,
    manifest: input.manifest,
    assetManifest: input.assetManifest,
    ...(input.workerFiles && Object.keys(input.workerFiles).length > 0
      ? { workerFiles: input.workerFiles }
      : {}),
  };
}

/**
 * Convert the canonical artifact into the stable hosted-platform wire shape.
 * Pass `workerInput` when the Worker modules were uploaded beforehand; the
 * artifact must then carry no inline `workerFiles`.
 */
export function createDeployUploadPayload(
  artifact: DeployArtifact,
  metadata: DeploySourceMetadata & { preflight: 'true' | null },
  workerInput?: DeployWorkerInput,
): DeployUploadPayload {
  if (workerInput && artifact.workerFiles) {
    throw new Error('A deployment sends its Worker modules inline or as uploads, not both.');
  }
  return {
    manifest: { ...artifact.manifest, bindings: { ...artifact.manifest.bindings } },
    assetManifest: { ...artifact.assetManifest },
    ...(artifact.workerFiles ? { workerFiles: { ...artifact.workerFiles } } : {}),
    ...(workerInput
      ? {
          workerInput: {
            id: workerInput.id,
            modules: workerInput.modules.map((module) => ({ ...module })),
          },
        }
      : {}),
    ...metadata,
  };
}
