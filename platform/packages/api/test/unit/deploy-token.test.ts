import { describe, it, expect } from 'vite-plus/test';
import { signDeployToken, signPrerenderToken } from '../../src/auth/deploy-token.ts';
import { signJwt, verifyJwt } from '../../src/auth/jwt.ts';
import { verifyDeployToken, verifyPrerenderToken } from '../helpers/project-token.ts';

const SECRET = 'test-secret-key-for-deploy-token';

describe('deploy token', () => {
  it('round-trips and verifies with aud deploy', async () => {
    const token = await signDeployToken(
      { projectId: 'proj_abc', userId: 'user_xyz', login: 'octocat', buildId: 'bld_123' },
      SECRET,
    );

    const payload = await verifyDeployToken(token, SECRET);
    expect(payload).not.toBeNull();
    expect(payload!.aud).toBe('deploy');
    expect(payload!.sub).toBe('user_xyz');
    expect(payload!.login).toBe('octocat');
    expect(payload!.project).toBe('proj_abc');
    expect(payload!.build).toBe('bld_123');
    expect(payload!.credential).toBeUndefined();
  });

  it('mints a ~15-minute token', async () => {
    const token = await signDeployToken(
      { projectId: 'proj_abc', userId: 'user_xyz', login: 'octocat', buildId: 'bld_123' },
      SECRET,
    );
    const payload = await verifyDeployToken(token, SECRET);
    expect(payload).not.toBeNull();
    expect(payload!.exp - payload!.iat).toBe(15 * 60);
  });

  it('a deploy token fails verifyJwt with aud api', async () => {
    const token = await signDeployToken(
      { projectId: 'proj_abc', userId: 'user_xyz', login: 'octocat', buildId: 'bld_123' },
      SECRET,
    );
    expect(await verifyJwt(token, SECRET, 'api')).toBeNull();
  });

  it('verifyDeployToken rejects an api token', async () => {
    const token = await signJwt({ sub: 'user_xyz', login: 'octocat', aud: 'api' }, SECRET);
    expect(await verifyDeployToken(token, SECRET)).toBeNull();
  });

  it('verifyDeployToken returns null for wrong secret', async () => {
    const token = await signDeployToken(
      { projectId: 'proj_abc', userId: 'user_xyz', login: 'octocat', buildId: 'bld_123' },
      SECRET,
    );
    expect(await verifyDeployToken(token, 'wrong-secret')).toBeNull();
  });
});

describe('prerender token', () => {
  it('is short-lived and pinned to one project', async () => {
    const token = await signPrerenderToken(
      { projectId: 'proj_abc', userId: 'user_xyz', login: 'octocat' },
      SECRET,
    );

    const payload = await verifyPrerenderToken(token, SECRET);
    expect(payload).not.toBeNull();
    expect(payload).toMatchObject({
      aud: 'prerender',
      sub: 'user_xyz',
      project: 'proj_abc',
    });
    expect(payload!.exp - payload!.iat).toBe(5 * 60);
    expect(await verifyDeployToken(token, SECRET)).toBeNull();
    expect(await verifyJwt(token, SECRET, 'api')).toBeNull();
  });
});

describe('signJwt backward compatibility', () => {
  it('2-arg signJwt still defaults to ~30-day TTL', async () => {
    const token = await signJwt({ sub: 'user_abc', login: 'octocat', aud: 'api' }, SECRET);
    const payload = await verifyJwt(token, SECRET, 'api');
    expect(payload).not.toBeNull();
    expect(payload!.exp - payload!.iat).toBe(30 * 24 * 60 * 60);
  });

  it('honors an explicit ttlSeconds override', async () => {
    const token = await signJwt({ sub: 'user_abc', login: 'octocat', aud: 'api' }, SECRET, {
      ttlSeconds: 60,
    });
    const payload = await verifyJwt(token, SECRET, 'api');
    expect(payload).not.toBeNull();
    expect(payload!.exp - payload!.iat).toBe(60);
  });
});
