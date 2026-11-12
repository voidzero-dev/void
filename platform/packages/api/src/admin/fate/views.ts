import { defer, view } from 'react-fate';
import type {
  AdminUsersPage,
  AdminProjectsPage,
  AdminDeploymentsPage,
  AdminDeploymentDetail,
} from './client.ts';
import type {
  AdminPlans,
  AdminDashboard,
  AdminTopProject,
  AdminHealth,
  AdminUserDetail,
  AdminProjectDetail,
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
  suggestions: true,
  search: true,
  page: true,
  totalPages: true,
  tz: true,
});
export const ProjectsPageView = view<AdminProjectsPage>()({
  id: true,
  projects: true,
  suggestions: true,
  search: true,
  page: true,
  totalPages: true,
  siteDomain: true,
  tz: true,
});
export const DeploymentsPageView = view<AdminDeploymentsPage>()({
  id: true,
  deployments: true,
  suggestions: true,
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
  limits: true,
  plans: true,
  id: true,
  user: true,
  projects: true,
  deploysToday: true,
  usage: true,
  tz: true,
});
export const ProjectDetailView = view<AdminProjectDetail>()({
  id: true,
  project: true,
  deployments: true,
  resources: true,
  owner: true,
  teamMembers: true,
  pendingTeamInvitations: true,
  domains: true,
  builds: true,
  zeroTrust: true,
  cfAccountId: true,
  deployUrl: true,
  tz: true,
});
export const DeploymentLogSettingsView = view<AdminDeploymentDetail>()({
  id: true,
  logRange: true,
  logLimit: true,
  logFilter: true,
});

export const DeploymentDetailView = view<AdminDeploymentDetail>()({
  ...DeploymentLogSettingsView,
  id: true,
  deployment: true,
  project: true,
  manifest: true,
  manifestJson: true,
  canCancel: true,
  tz: true,
});
export const BuildDetailView = view<AdminBuildDetail>()({
  id: true,
  build: true,
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
  admission: true,
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
  data: true,
  tested: true,
});
export const AuthNewView = view<AdminAuthNew>()({
  id: true,
  kind: true,
  connectionId: true,
  callbackUrl: true,
});
export const AuthEditView = view<AdminAuthEdit>()({
  id: true,
  configuration: true,
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
  policy: true,
  management: true,
  senderDomain: true,
});
export const EmailProjectView = view<AdminEmailProject>()({
  id: true,
  projectId: true,
  project: true,
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
  operation: true,
  lastError: true,
  checked: true,
  live: true,
  projects: true,
});

export const zeroTrustRequest = (path: string) =>
  ({
    zeroTrust: { view: ZeroTrustView, args: { path } },
  }) as const;

export const PlansView = view<AdminPlans>()({
  id: true,
  catalog: true,
  accounts: true,
  selectedPlanId: true,
});
export const plansRequest = (path: string) =>
  ({ plans: { view: PlansView, args: { path } } }) as const;

export const UserSuggestionsView = view<AdminUsersPage>()({ suggestions: true });
export const ProjectSuggestionsView = view<AdminProjectsPage>()({ suggestions: true });
export const DeploymentSuggestionsView = view<AdminDeploymentsPage>()({ suggestions: true });
export const userSuggestionsRequest = (path: string) =>
  ({ usersPage: { view: UserSuggestionsView, args: { path } } }) as const;
export const projectSuggestionsRequest = (path: string) =>
  ({ projectsPage: { view: ProjectSuggestionsView, args: { path } } }) as const;
export const deploymentSuggestionsRequest = (path: string) =>
  ({ deploymentsPage: { view: DeploymentSuggestionsView, args: { path } } }) as const;
