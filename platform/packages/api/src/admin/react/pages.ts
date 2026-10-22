export const adminComponents = {
  connectedApps: async () => ({
    default: (await import('./views/ConnectedAppsPage.tsx')).ConnectedAppsPage,
  }),
  platformStatus: async () => ({
    default: (await import('./views/PlatformStatusPage.tsx')).PlatformStatusPage,
  }),
  adminLayout: async () => ({ default: (await import('./AdminProviders.tsx')).AdminProviders }),
  dashboard: async () => ({ default: (await import('./views/DashboardPage.tsx')).DashboardPage }),
  adminLogin: async () => ({
    default: (await import('./views/AdminLoginPage.tsx')).AdminLoginPage,
  }),
  loginError: async () => ({
    default: (await import('./views/LoginErrorPage.tsx')).LoginErrorPage,
  }),
  plans: async () => ({ default: (await import('./views/PlansPage.tsx')).PlansPage }),
  planEdit: async () => ({ default: (await import('./views/PlansPage.tsx')).PlanEditPage }),
  planPreview: async () => ({ default: (await import('./views/PlansPage.tsx')).PlanPreviewPage }),
  planProgress: async () => ({ default: (await import('./views/PlansPage.tsx')).PlanProgressPage }),
  authSettings: async () => ({
    default: (await import('./views/AuthSettingsPage.tsx')).AuthSettingsPage,
  }),
  authNew: async () => ({ default: (await import('./views/AuthNewPage.tsx')).AuthNewPage }),
  authEdit: async () => ({ default: (await import('./views/AuthEditPage.tsx')).AuthEditPage }),
  authError: async () => ({ default: (await import('./views/AuthErrorPage.tsx')).AuthErrorPage }),
  buildDetail: async () => ({
    default: (await import('./views/BuildDetailPage.tsx')).BuildDetailPage,
  }),
  deploymentDetail: async () => ({
    default: (await import('./views/DeploymentDetailPage.tsx')).DeploymentDetailPage,
  }),
  users: async () => ({ default: (await import('./views/UsersListPage.tsx')).UsersListPage }),
  userDetail: async () => ({
    default: (await import('./views/UserDetailPage.tsx')).UserDetailPage,
  }),
  projects: async () => ({
    default: (await import('./views/ProjectsListPage.tsx')).ProjectsListPage,
  }),
  projectDetail: async () => ({
    default: (await import('./views/ProjectDetailPage.tsx')).ProjectDetailPage,
  }),
  projectOwnerPreview: async () => ({
    default: (await import('./views/ProjectOwnerPreviewPage.tsx')).ProjectOwnerPreviewPage,
  }),
  deployments: async () => ({
    default: (await import('./views/DeploymentsListPage.tsx')).DeploymentsListPage,
  }),
  cliVersions: async () => ({
    default: (await import('./views/CliVersionsPage.tsx')).CliVersionsPage,
  }),
  signupControl: async () => ({
    default: (await import('./views/SignupControlPage.tsx')).SignupControlPage,
  }),
  email: async () => ({
    default: (await import('./views/EmailSettingsPage.tsx')).EmailSettingsPage,
  }),
  emailProject: async () => ({
    default: (await import('./views/EmailProjectPage.tsx')).EmailProjectPage,
  }),
  emailOperation: async () => ({
    default: (await import('./views/EmailOperationPage.tsx')).EmailOperationPage,
  }),
  adminError: async () => ({
    default: (await import('./views/AdminErrorPage.tsx')).AdminErrorPage,
  }),
  invitations: async () => ({
    default: (await import('./views/InvitationsPage.tsx')).InvitationsPage,
  }),
  zeroTrust: async () => ({ default: (await import('./views/ZeroTrustPage.tsx')).ZeroTrustPage }),
};

export type AdminPageId = Exclude<keyof typeof adminComponents, 'adminLayout'>;

export const adminLayoutTree: Record<AdminPageId, Array<string>> = Object.fromEntries(
  Object.keys(adminComponents)
    .filter((name) => name !== 'adminLayout')
    .map((name) => [name, ['adminLayout']]),
) as Record<AdminPageId, Array<string>>;

/** Page id for a decoded pathname, as the Pages navigation engine passes it. */
export function matchAdminRoute(path: string): AdminPageId | null {
  if (path === '/admin/connected-apps') {
    return 'connectedApps';
  }
  if (path === '/admin/') {
    return 'dashboard';
  }
  if (path === '/admin/status') {
    return 'platformStatus';
  }
  if (path === '/admin/login') {
    return 'adminLogin';
  }
  if (path === '/admin/users') {
    return 'users';
  }
  if (/^\/admin\/builds\/[^/]+$/.test(path)) {
    return 'buildDetail';
  }
  if (/^\/admin\/users\/[^/]+$/.test(path)) {
    return 'userDetail';
  }
  if (path === '/admin/projects') {
    return 'projects';
  }
  if (/^\/admin\/projects\/[^/]+$/.test(path)) {
    return 'projectDetail';
  }
  if (/^\/admin\/projects\/[^/]+\/owner\/preview$/.test(path)) {
    return 'projectOwnerPreview';
  }
  if (path === '/admin/deployments') {
    return 'deployments';
  }
  if (/^\/admin\/deployments\/[^/]+$/.test(path)) {
    return 'deploymentDetail';
  }
  if (path === '/admin/cli-versions') {
    return 'cliVersions';
  }
  if (path === '/admin/signup-control') {
    return 'signupControl';
  }
  if (path === '/admin/config/plans') {
    return 'plans';
  }
  if (path === '/admin/config/plans/new' || /^\/admin\/config\/plans\/[^/]+\/edit$/.test(path)) {
    return 'planEdit';
  }
  if (path === '/admin/config/plans/preview') {
    return 'planPreview';
  }
  if (path === '/admin/config/plans/apply' || path === '/admin/config/plans/resume') {
    return 'planProgress';
  }
  if (path === '/admin/config/auth') {
    return 'authSettings';
  }
  if (path === '/admin/config/auth/new') {
    return 'authNew';
  }
  if (/^\/admin\/config\/auth\/connections\/[^/]+$/.test(path)) {
    return 'authEdit';
  }
  if (path === '/admin/email') {
    return 'email';
  }
  if (/^\/admin\/email\/[^/]+$/.test(path)) {
    return 'emailProject';
  }
  if (path === '/admin/invitations') {
    return 'invitations';
  }
  if (path === '/admin/zero-trust') {
    return 'zeroTrust';
  }
  return null;
}
