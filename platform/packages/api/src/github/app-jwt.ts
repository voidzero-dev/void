import { importPKCS8, SignJWT } from 'jose';
import type { ApiEnv } from '../env.ts';

// Cache the imported signing key per PKCS#8 PEM string — importPKCS8 is
// expensive and the private key never changes per isolate.
const keyCache = new Map<string, CryptoKey>();

async function getSigningKey(privateKeyPem: string): Promise<CryptoKey> {
  let key = keyCache.get(privateKeyPem);
  if (!key) {
    key = await importPKCS8(privateKeyPem, 'RS256');
    keyCache.set(privateKeyPem, key);
  }
  return key;
}

/**
 * Mint a short-lived RS256 GitHub App JWT used to authenticate as the App
 * itself (e.g. to mint installation tokens). `iss` is the numeric App ID,
 * issued 60s in the past to tolerate clock skew, expiring in 9 minutes
 * (GitHub caps App JWTs at 10 minutes).
 */
export async function createAppJwt(env: ApiEnv['Bindings']): Promise<string> {
  const { GITHUB_APP_PRIVATE_KEY: privateKey, GITHUB_APP_ID: appId } = env;
  if (!privateKey || !appId) {
    throw new Error('GitHub App credentials are not configured.');
  }
  const key = await getSigningKey(privateKey);
  const now = Math.floor(Date.now() / 1000);

  return new SignJWT({})
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(appId)
    .setIssuedAt(now - 60)
    .setExpirationTime('9m')
    .sign(key);
}
