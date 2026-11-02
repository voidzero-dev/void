/** @jsxImportSource @voidcloud/api/admin-jsx */
import { AppShell } from '@astryxdesign/core/AppShell';
import { DropdownMenu } from '@astryxdesign/core/DropdownMenu';
import { SideNav, SideNavItem, SideNavSection } from '@astryxdesign/core/SideNav';
import { TopNav, TopNavHeading } from '@astryxdesign/core/TopNav';
import { useNavigation, useRouter } from '@void/react';
import {
  FolderKanban,
  Activity,
  LayoutDashboard,
  LockKeyhole,
  LogOut,
  Mail,
  Rocket,
  SlidersHorizontal,
  ShieldCheck,
  ShieldLock,
  Terminal,
  Users,
} from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { formatPlatformPageTitle } from '../../../platform-identity.ts';
import { PageStack } from './PageStack.tsx';
import { VoidLogo } from './VoidLogo.tsx';

let isSideNavCollapsed = false;

export function Layout({
  title,
  platformName,
  username,
  children,
}: {
  title: string;
  platformName: string;
  username?: string;
  children: ReactNode;
}) {
  const routerPath = useRouter().path;
  const path = useNavigation().location?.pathname ?? routerPath;
  const [collapsed, setCollapsed] = useState(isSideNavCollapsed);
  useEffect(() => {
    document.title = formatPlatformPageTitle(title, platformName);
  }, [title, platformName]);

  useEffect(() => {
    const onSubmit = (event: SubmitEvent) => {
      const form = event.target;
      if (!(form instanceof HTMLFormElement)) {
        return;
      }
      const message = form.dataset.confirm;
      if (message && !window.confirm(message)) {
        event.preventDefault();
      }
    };
    document.addEventListener('submit', onSubmit, true);
    return () => document.removeEventListener('submit', onSubmit, true);
  }, []);

  return (
    <AppShell
      className="void-admin-shell"
      height="auto"
      contentPadding={6}
      mobileNav={{ breakpoint: 'lg' }}
      topNav={
        <TopNav
          label="Platform administration"
          heading={
            <TopNavHeading
              className="void-admin-brand"
              logo={<VoidLogo />}
              heading={platformName}
            />
          }
          endContent={
            <DropdownMenu
              button={{ label: username ?? 'Account', variant: 'ghost' }}
              alignment="end"
              items={[
                {
                  label: 'Log out',
                  icon: LogOut,
                  onClick: () => window.location.assign('/admin/logout'),
                },
              ]}
            />
          }
        />
      }
      sideNav={
        <SideNav
          aria-label="Admin sections"
          collapsible={{
            isCollapsed: collapsed,
            onCollapsedChange: (next: boolean) => {
              isSideNavCollapsed = next;
              setCollapsed(next);
            },
          }}
        >
          <SideNavSection title="Overview">
            <SideNavItem
              label="Dashboard"
              icon={LayoutDashboard}
              href="/admin/"
              isSelected={path === '/admin/'}
            />
          </SideNavSection>
          <SideNavSection title="Applications">
            <SideNavItem
              label="Connected apps"
              icon={LockKeyhole}
              href="/admin/connected-apps"
              isSelected={path.startsWith('/admin/connected-apps')}
            />
            <SideNavItem
              label="Projects"
              icon={FolderKanban}
              href="/admin/projects"
              isSelected={path.startsWith('/admin/projects')}
            />
            <SideNavItem
              label="Deployments"
              icon={Rocket}
              href="/admin/deployments"
              isSelected={path.startsWith('/admin/deployments')}
            />
          </SideNavSection>
          <SideNavSection title="People">
            <SideNavItem
              label="Users"
              icon={Users}
              href="/admin/users"
              isSelected={path.startsWith('/admin/users')}
            />
            <SideNavItem
              label="Access"
              icon={LockKeyhole}
              href="/admin/signup-control"
              isSelected={
                path.startsWith('/admin/signup-control') || path.startsWith('/admin/invitations')
              }
            />
          </SideNavSection>
          <SideNavSection title="Platform">
            <SideNavItem
              label="Platform status"
              icon={Activity}
              href="/admin/status"
              isSelected={path === '/admin/status'}
            />
            <SideNavItem
              label="Plans"
              icon={SlidersHorizontal}
              href="/admin/config/plans"
              isSelected={path.startsWith('/admin/config/plans')}
            />
            <SideNavItem
              label="Authentication"
              icon={ShieldCheck}
              href="/admin/config/auth"
              isSelected={path.startsWith('/admin/config/auth')}
            />
            <SideNavItem
              label="Email"
              icon={Mail}
              href="/admin/email"
              isSelected={path.startsWith('/admin/email')}
            />
            <SideNavItem
              label="Zero Trust"
              icon={ShieldLock}
              href="/admin/zero-trust"
              isSelected={path === '/admin/zero-trust'}
            />
            <SideNavItem
              label="CLI Versions"
              icon={Terminal}
              href="/admin/cli-versions"
              isSelected={path === '/admin/cli-versions'}
            />
          </SideNavSection>
        </SideNav>
      }
    >
      <PageStack className="void-admin-content">{children}</PageStack>
    </AppShell>
  );
}
