import { defer, view } from 'react-fate';
import type {
  AdminPlans,
  AdminDashboard,
  AdminTopProject,
  AdminHealth,
  AdminUsersPage,
  AdminProjectsPage,
  AdminDeploymentsPage,
  AdminUserDetail,
  AdminProjectDetail,
  AdminDeploymentDetail,
  AdminBuildDetail,
  AdminCliVersions,
  AdminSignup,
  AdminInvitations,
  AdminAuthSettings,
  AdminAuthNew,
  AdminAuthEdit,
  AdminEmailSettings,
  AdminEmailProject,
  AdminZeroTrust,
  AdminBuildLogs,
  AdminDeploymentLogs,
} from './server.ts';

export const TopProjectView = view<AdminTopProject>()({
  id: true,
  user_id: true,
  slug: true,
  type: true,
  owner_login: true,
  requests: true,
  bandwidthBytes: true,
  lastSeen: true,
  url: true,
});

export const DashboardView = view<AdminDashboard>()({
  id: true,
  userCount: true,
  projectCount: true,
  deploymentCount: true,
  projects: true,
  deployments: true,
  siteDomain: true,
  tz: true,
  topProjects: defer({ items: { node: TopProjectView } }),
});

export const dashboardRequest = { dashboard: { view: DashboardView } } as const;

export const HealthView = view<AdminHealth>()({
  id: true,
  allOk: true,
  checks: true,
  checkedAt: true,
});
export const healthRequest = { health: { view: HealthView } } as const;

export const BuildLogsView = view<AdminBuildLogs>()({
  id: true,
  lines: true,
  lastSeq: true,
  terminal: true,
  logsComplete: true,
});
export const DeploymentLogsView = view<AdminDeploymentLogs>()({
  id: true,
  data: true,
  runtimeLogs: true,
});
export const buildLogsRequest = (id: string, since: number) =>
  ({ buildLogs: { view: BuildLogsView, args: { id, since } } }) as const;
export const deploymentLogsRequest = (id: string, since: string, limit: number) =>
  ({ deploymentLogs: { view: DeploymentLogsView, args: { id, since, limit } } }) as const;

export const UsersPageView = view<AdminUsersPage>()({
  id: true,
  users: true,
  search: true,
  page: true,
  totalPages: true,
  tz: true,
});
export const ProjectsPageView = view<AdminProjectsPage>()({
  id: true,
  projects: true,
  search: true,
  page: true,
  totalPages: true,
  siteDomain: true,
  tz: true,
});
export const DeploymentsPageView = view<AdminDeploymentsPage>()({
  id: true,
  deployments: true,
  search: true,
  page: true,
  totalPages: true,
  tz: true,
});

export const usersPageRequest = (path: string) =>
  ({
    usersPage: { view: UsersPageView, args: { path } },
  }) as const;
export const projectsPageRequest = (path: string) =>
  ({
    projectsPage: { view: ProjectsPageView, args: { path } },
  }) as const;
export const deploymentsPageRequest = (path: string) =>
  ({
    deploymentsPage: { view: DeploymentsPageView, args: { path } },
  }) as const;

export const UserDetailView = view<AdminUserDetail>()({
  limits: true as never,
  plans: true,
  id: true,
  user: true as never,
  projects: true,
  deploysToday: true,
  usage: true as never,
  tz: true,
});
export const ProjectDetailView = view<AdminProjectDetail>()({
  id: true,
  project: true as never,
  deployments: true,
  resources: true,
  owner: true as never,
  teamMembers: true,
  pendingTeamInvitations: true,
  domains: true,
  builds: true,
  zeroTrust: true as never,
  cfAccountId: true,
  deployUrl: true,
  tz: true,
});
export const DeploymentDetailView = view<AdminDeploymentDetail>()({
  id: true,
  deployment: true as never,
  project: true as never,
  manifest: true as never,
  canCancel: true,
  tz: true,
});
export const BuildDetailView = view<AdminBuildDetail>()({
  id: true,
  build: true as never,
  tz: true,
});

export const userDetailRequest = (path: string) =>
  ({
    userDetail: { view: UserDetailView, args: { path } },
  }) as const;
export const projectDetailRequest = (path: string) =>
  ({
    projectDetail: { view: ProjectDetailView, args: { path } },
  }) as const;
export const deploymentDetailRequest = (path: string) =>
  ({
    deploymentDetail: { view: DeploymentDetailView, args: { path } },
  }) as const;
export const buildDetailRequest = (path: string) =>
  ({
    buildDetail: { view: BuildDetailView, args: { path } },
  }) as const;

export const CliVersionsView = view<AdminCliVersions>()({
  id: true,
  allTime: true,
  last30Days: true,
  tz: true,
});
export const SignupView = view<AdminSignup>()({
  id: true,
  enabled: true,
  entries: true,
  directEntries: true,
  admission: true as never,
  connections: true,
  initialized: true,
  revision: true,
  methods: true,
  protection: true,
  invitations: true,
  page: true,
  totalPages: true,
  emailEnabled: true,
  connectCommand: true,
  inviteUrl: true,
  result: true,
  tz: true,
});
export const InvitationsView = view<AdminInvitations>()({
  id: true,
  invitations: true,
  page: true,
  totalPages: true,
  tz: true,
});

export const cliVersionsRequest = (path: string) =>
  ({
    cliVersions: { view: CliVersionsView, args: { path } },
  }) as const;
export const signupRequest = (path: string) =>
  ({
    signupControl: { view: SignupView, args: { path } },
  }) as const;
export const invitationsRequest = (path: string) =>
  ({
    invitations: { view: InvitationsView, args: { path } },
  }) as const;

export const AuthSettingsView = view<AdminAuthSettings>()({
  id: true,
  data: true as never,
  tested: true as never,
});
export const AuthNewView = view<AdminAuthNew>()({
  id: true,
  kind: true,
  connectionId: true,
  callbackUrl: true,
});
export const AuthEditView = view<AdminAuthEdit>()({
  id: true,
  configuration: true as never,
  label: true,
  revision: true,
  callbackUrl: true,
});

export const authSettingsRequest = (path: string) =>
  ({
    authSettings: { view: AuthSettingsView, args: { path } },
  }) as const;
export const authNewRequest = (path: string) =>
  ({
    authNew: { view: AuthNewView, args: { path } },
  }) as const;
export const authEditRequest = (path: string) =>
  ({
    authEdit: { view: AuthEditView, args: { path } },
  }) as const;

export const EmailSettingsView = view<AdminEmailSettings>()({
  id: true,
  policy: true as never,
  management: true as never,
  senderDomain: true,
});
export const EmailProjectView = view<AdminEmailProject>()({
  id: true,
  projectId: true,
  project: true as never,
  month: true,
  attempts: true,
  received: true,
  monthlyLimit: true,
  burstLimit: true,
  isSuspended: true,
  domains: true,
  destinations: true,
  senderDomain: true,
  tz: true,
});

export const emailSettingsRequest = (path: string) =>
  ({
    emailSettings: { view: EmailSettingsView, args: { path } },
  }) as const;
export const emailProjectRequest = (path: string) =>
  ({
    emailProject: { view: EmailProjectView, args: { path } },
  }) as const;

export const ZeroTrustView = view<AdminZeroTrust>()({
  id: true,
  configured: true,
  enabled: true,
  status: true,
  accountId: true,
  teamDomain: true,
  identityProviderIds: true,
  policyIds: true,
  protectNewProjects: true,
  operation: true as never,
  lastError: true,
  checked: true,
  live: true as never,
  projects: true,
});

export const zeroTrustRequest = (path: string) =>
  ({
    zeroTrust: { view: ZeroTrustView, args: { path } },
  }) as const;

export const PlansView = view<AdminPlans>()({
  id: true,
  catalog: true as never,
  accounts: true,
  selectedPlanId: true,
});
export const plansRequest = (path: string) =>
  ({ plans: { view: PlansView, args: { path } } }) as const;
