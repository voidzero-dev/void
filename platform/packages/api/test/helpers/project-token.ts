import { verifyJwt } from '../../src/auth/jwt.ts';

export function verifyDeployToken(token: string, secret: string) {
  return verifyJwt(token, secret, 'deploy');
}

export function verifyPrerenderToken(token: string, secret: string) {
  return verifyJwt(token, secret, 'prerender');
}
