import { describe, expect, it } from 'vite-plus/test';
import { isPublicDashboardPath } from '../../middleware/01.auth.ts';

describe('dashboard auth middleware', () => {
  it('allows unauthenticated public pages and built assets', () => {
    expect(isPublicDashboardPath('/login')).toBe(true);
    expect(isPublicDashboardPath('/logout')).toBe(true);
    expect(isPublicDashboardPath('/favicon.svg')).toBe(true);
    expect(isPublicDashboardPath('/auth/callback')).toBe(true);
    expect(isPublicDashboardPath('/assets/pages-client.js')).toBe(true);
    expect(isPublicDashboardPath('/assets/layout.css')).toBe(true);
  });

  it('keeps every non-auth route behind authentication', () => {
    expect(isPublicDashboardPath('/')).toBe(false);
    expect(isPublicDashboardPath('/private')).toBe(false);
    expect(isPublicDashboardPath('/account')).toBe(false);
    expect(isPublicDashboardPath('/assetz/layout.css')).toBe(false);
  });
});
