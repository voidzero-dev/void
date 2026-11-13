/** @jsxImportSource react */

import { Button } from '@astryxdesign/core/Button';
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from '@astryxdesign/core/Table';
import { useToast } from '@astryxdesign/core/Toast';
import {
  PLAN_EDITABLE_LIMIT_KEYS,
  PLAN_LIMITS,
  type EditablePlanLimit,
  type PlatformPlanDefinition,
} from '@void/platform/plans';
import { Link } from '@void/react';
import { useEffect, useState } from 'react';
import { useRequest, useView } from 'react-fate';
import { PlansView, plansRequest } from '../../fate/views.ts';
import type { AdminPlanPreview, AdminPlanProgress } from '../../plans.ts';
import type { AdminPageProps } from '../page-utils.ts';
import { FormCheckbox, FormNumberInput, FormSelector, FormTextInput } from './FormControls.tsx';
import { Layout } from './Layout.tsx';
import { PageStack } from './PageStack.tsx';
import { SectionStack } from './SectionStack.tsx';

const HOME = '/admin/config/plans';
const fields: Array<{ title: string; keys: Array<EditablePlanLimit> }> = [
  {
    title: 'Requests',
    keys: [
      'requestsPerMonth',
      'cpuMsPerRequest',
      'maxCpuMsPerRequest',
      'subRequestsPerInvocation',
      'aiNeuronsPerMonth',
    ],
  },
  {
    title: 'Deployments and builds',
    keys: ['deploysPerDay', 'retainedDeployments', 'concurrentBuilds', 'buildTimeoutMinutes'],
  },
  { title: 'Sandbox', keys: ['sandboxRuntimeSecondsPerMonth', 'sandboxMaxConcurrentInstances'] },
];
const labels: Record<EditablePlanLimit, string> = {
  requestsPerMonth: 'Requests per billing month',
  cpuMsPerRequest: 'Default CPU per request (ms)',
  maxCpuMsPerRequest: 'Maximum app CPU per request (ms)',
  subRequestsPerInvocation: 'Subrequests per invocation',
  aiNeuronsPerMonth: 'AI neurons per billing month',
  deploysPerDay: 'Deployments per day',
  retainedDeployments: 'Retained Worker deployments',
  concurrentBuilds: 'Concurrent builds',
  buildTimeoutMinutes: 'Build timeout (minutes)',
  sandboxRuntimeSecondsPerMonth: 'Sandbox runtime per billing month (seconds)',
  sandboxMaxConcurrentInstances: 'Concurrent Sandbox instances',
};
function limit(value: number, key?: EditablePlanLimit) {
  return value === 0
    ? key === 'buildTimeoutMinutes'
      ? '60 minutes (platform maximum)'
      : 'Unlimited'
    : value.toLocaleString('en-US');
}
function usePlans(path: string) {
  const { plans: ref } = useRequest(plansRequest(path), { mode: 'stale-while-revalidate' });
  const data = useView(PlansView, ref);
  if (!data) {
    throw new Error('Plans are unavailable.');
  }
  return data;
}

function usePlanConfirmation(path: string) {
  const toast = useToast();
  useEffect(() => {
    const url = new URL(window.location.href);
    const messages: Record<string, string> = {
      'plan-saved': 'Plan saved.',
      'plan-removed': 'Plan removed.',
      'plans-updated': 'Account updates complete.',
    };
    const notice = url.searchParams.get('notice') ?? '';
    const message = Object.hasOwn(messages, notice) ? messages[notice] : undefined;
    if (!message) {
      return;
    }
    url.searchParams.delete('notice');
    url.searchParams.delete('revision');
    window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
    toast({ body: message, isAutoHide: true, autoHideDuration: 4000 });
  }, [path, toast]);
}
function PlanAction({
  action,
  id,
  revision,
  label,
  archived,
}: {
  action: string;
  id: string;
  revision: number;
  label: string;
  archived?: boolean;
}) {
  return (
    <form method="post" action={`${HOME}/preview`}>
      <input type="hidden" name="action" defaultValue={action} />
      <input type="hidden" name="id" defaultValue={id} />
      <input type="hidden" name="revision" defaultValue={revision} />
      {archived !== undefined && (
        <input type="hidden" name="archived" defaultValue={String(archived)} />
      )}
      <Button type="submit" label={label} variant="secondary" />
    </form>
  );
}

export function PlansPage({ path, platformName, username }: AdminPageProps) {
  usePlanConfirmation(path);
  const { catalog, accounts } = usePlans(path);
  const pending = catalog.reconciliation && !catalog.reconciliation.complete;
  return (
    <Layout platformName={platformName} username={username} title="Plans">
      <SectionStack>
        <div className="void-admin-plan-heading">
          <h1>Plans</h1>
          <Button href={`${HOME}/new`} label="Add plan" />
        </div>
        <p>
          Default for new accounts:{' '}
          <strong>{catalog.plans.find((p) => p.id === catalog.defaultPlanId)?.name}</strong>.
          Changes to this default leave existing accounts on their current plans.
        </p>
      </SectionStack>
      {pending && (
        <SectionStack aria-label="Pending plan update">
          <h2>Account updates pending</h2>
          <p>
            Finish this update before changing plans again. Recorded usage and billing periods are
            preserved.
          </p>
          {catalog.reconciliation?.error && (
            <p role="alert">{catalog.reconciliation.error.message}</p>
          )}
          <form method="post" action={`${HOME}/resume`}>
            <input type="hidden" name="revision" defaultValue={catalog.revision} />
            <Button type="submit" label="Continue account updates" />
          </form>
        </SectionStack>
      )}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHeaderCell>Plan</TableHeaderCell>
            <TableHeaderCell>Status</TableHeaderCell>
            <TableHeaderCell>Accounts</TableHeaderCell>
            <TableHeaderCell>Monthly requests</TableHeaderCell>
            <TableHeaderCell>Build size</TableHeaderCell>
            <TableHeaderCell>Actions</TableHeaderCell>
          </TableRow>
        </TableHeader>
        <TableBody>
          {catalog.plans.map((plan) => (
            <TableRow key={plan.id}>
              <TableCell>
                <Link className="void-admin-resource-link" href={`${HOME}/${plan.id}/edit`}>
                  {plan.name}
                </Link>
                <div>
                  <code>{plan.id}</code>
                </div>
              </TableCell>
              <TableCell>
                {plan.archived
                  ? 'Archived'
                  : plan.id === catalog.defaultPlanId
                    ? 'Default'
                    : 'Active'}
              </TableCell>
              <TableCell>{accounts.find((a) => a.planId === plan.id)?.count ?? 0}</TableCell>
              <TableCell>{limit(plan.limits.requestsPerMonth)}</TableCell>
              <TableCell>
                {plan.buildInstanceType === 'standard-3' ? 'Standard' : 'Large'}
              </TableCell>
              <TableCell>
                <Button
                  href={`${HOME}/${plan.id}/edit`}
                  label="Edit"
                  variant="secondary"
                  size="sm"
                />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Layout>
  );
}

export function PlanEditPage({ path, platformName, username }: AdminPageProps) {
  usePlanConfirmation(path);
  const { catalog, accounts, selectedPlanId } = usePlans(path);
  const plan = catalog.plans.find((p) => p.id === selectedPlanId);
  const pending = catalog.reconciliation && !catalog.reconciliation.complete;
  const count = accounts.find((a) => a.planId === plan?.id)?.count ?? 0;
  return (
    <Layout
      platformName={platformName}
      username={username}
      title={plan ? `Edit ${plan.name}` : 'Add plan'}
    >
      <h1>{plan ? `Edit ${plan.name}` : 'Add plan'}</h1>
      {pending ? (
        <p>
          Finish the pending <Link href={HOME}>account update</Link> before changing plans.
        </p>
      ) : (
        <>
          <PageStack
            as="form"
            method="post"
            action={`${HOME}/preview`}
            className="void-admin-plan-form"
          >
            <SectionStack as="div">
              <input type="hidden" name="action" defaultValue={plan ? 'set' : 'add'} />
              <input type="hidden" name="revision" defaultValue={catalog.revision} />
              {plan ? (
                <>
                  <input type="hidden" name="id" defaultValue={plan.id} />
                  <p>
                    Plan ID: <code>{plan.id}</code> · {count} accounts
                    {plan.archived ? ' · Archived' : ''}
                  </p>
                </>
              ) : (
                <FormTextInput
                  label="Plan ID"
                  name="id"
                  required
                  maxLength={64}
                  description="A stable ID using lowercase letters, digits, and hyphens."
                />
              )}
              <FormTextInput
                label="Display name"
                name="name"
                initialValue={plan?.name ?? ''}
                required
                maxLength={80}
              />
            </SectionStack>
            {plan ? (
              <>
                <p>
                  0 means unlimited by the plan. Build timeouts always have a maximum of 60 minutes.
                </p>
                {fields.map((group) => (
                  <SectionStack key={group.title}>
                    <h2>{group.title}</h2>
                    <div className="void-admin-plan-fields">
                      {group.keys.map((key) => (
                        <FormNumberInput
                          key={`${plan.id}:${key}`}
                          name={key}
                          label={labels[key]}
                          initialValue={plan.limits[key]}
                          min={0}
                          max={key === 'buildTimeoutMinutes' ? 60 : undefined}
                          required
                        />
                      ))}
                    </div>
                  </SectionStack>
                ))}
                <SectionStack>
                  <p>
                    The default CPU limit must fit the maximum app CPU limit. An unlimited default
                    requires an unlimited maximum.
                  </p>
                  <h2>Build size and permissions</h2>
                  <FormSelector
                    label="Build size"
                    name="buildInstanceType"
                    initialValue={plan.buildInstanceType}
                    options={[
                      { value: 'standard-3', label: 'Standard · 2 vCPU, 8 GiB' },
                      { value: 'standard-4', label: 'Large · 4 vCPU, 12 GiB' },
                    ]}
                  />
                  <FormCheckbox
                    label="Allow short project names (five characters or fewer)"
                    name="allowShortSlugs"
                    submitValue="true"
                    initialValue={plan.allowShortSlugs}
                  />
                  <p>
                    Existing URLs remain available. Storage figures are informational; static
                    deployment retention is unchanged.
                  </p>
                </SectionStack>
              </>
            ) : (
              <FormSelector
                label="Copy limits, build size, and permissions from"
                name="copyFrom"
                initialValue={catalog.defaultPlanId}
                options={catalog.plans.map((p) => ({ value: p.id, label: `${p.name} (${p.id})` }))}
              />
            )}
            <Button type="submit" label="Review changes" />
          </PageStack>
          {plan && (
            <PageStack>
              <SectionStack>
                <h2>Plan management</h2>
                <div className="void-admin-plan-actions">
                  {!plan.archived && plan.id !== catalog.defaultPlanId && (
                    <PlanAction
                      action="default"
                      id={plan.id}
                      revision={catalog.revision}
                      label="Make signup default"
                    />
                  )}
                  {plan.id !== catalog.defaultPlanId && (
                    <PlanAction
                      action="archive"
                      id={plan.id}
                      revision={catalog.revision}
                      archived={!plan.archived}
                      label={plan.archived ? 'Restore assignments' : 'Archive plan'}
                    />
                  )}
                  {Object.hasOwn(PLAN_LIMITS, plan.id) && (
                    <PlanAction
                      action="reset"
                      id={plan.id}
                      revision={catalog.revision}
                      label="Reset original limits"
                    />
                  )}
                </div>
                {plan.id === catalog.defaultPlanId && (
                  <p>Choose another signup default before archiving this plan.</p>
                )}
              </SectionStack>
              <SectionStack>
                <h2>Remove plan</h2>
                <p>Accounts keep their recorded usage when moved to a replacement plan.</p>
                <SectionStack
                  as="form"
                  method="post"
                  action={`${HOME}/preview`}
                  className="void-admin-plan-form"
                >
                  <input type="hidden" name="action" defaultValue="remove" />
                  <input type="hidden" name="id" defaultValue={plan.id} />
                  <input type="hidden" name="revision" defaultValue={catalog.revision} />
                  <FormSelector
                    label="Replacement plan"
                    name="replacementPlanId"
                    initialValue=""
                    options={[
                      ...(!count && plan.id !== catalog.defaultPlanId
                        ? [{ value: '', label: 'No replacement needed' }]
                        : [{ value: '', label: 'Choose a replacement' }]),
                      ...catalog.plans
                        .filter((p) => p.id !== plan.id && !p.archived)
                        .map((p) => ({ value: p.id, label: `${p.name} (${p.id})` })),
                    ]}
                  />
                  <Button type="submit" label="Review removal" variant="destructive" />
                </SectionStack>
              </SectionStack>
            </PageStack>
          )}
        </>
      )}
    </Layout>
  );
}

function differences(
  before: PlatformPlanDefinition | undefined,
  after: PlatformPlanDefinition | undefined,
) {
  if (!after) {
    return [{ label: 'Plan', before: before!.name, after: 'Removed' }];
  }
  const rows = [
    { label: 'Display name', before: before?.name ?? '—', after: after.name },
    {
      label: 'Assignments',
      before: before?.archived ? 'Archived' : before ? 'Active' : '—',
      after: after.archived ? 'Archived' : 'Active',
    },
    {
      label: 'Build size',
      before: before?.buildInstanceType ?? '—',
      after: after.buildInstanceType,
    },
    {
      label: 'Short project names',
      before: before ? (before.allowShortSlugs ? 'Allowed' : 'Not allowed') : '—',
      after: after.allowShortSlugs ? 'Allowed' : 'Not allowed',
    },
    ...PLAN_EDITABLE_LIMIT_KEYS.map((key) => ({
      label: labels[key],
      before: before ? limit(before.limits[key], key) : '—',
      after: limit(after.limits[key], key),
    })),
  ];
  return rows.filter((row) => row.before !== row.after);
}
export function PlanPreviewPage({
  preview,
  platformName,
  username,
}: {
  preview: AdminPlanPreview;
  platformName: string;
  username?: string;
}) {
  const { before, after, target } = preview;
  const changes = differences(
    before.plans.find((p) => p.id === target),
    after.plans.find((p) => p.id === target),
  );
  if (before.defaultPlanId !== after.defaultPlanId) {
    changes.push({
      label: 'Signup default',
      before: before.defaultPlanId,
      after: after.defaultPlanId,
    });
  }
  if (preview.action === 'remove' && preview.body.replacementPlanId) {
    changes.push({
      label: 'Move accounts to',
      before: target,
      after: String(preview.body.replacementPlanId),
    });
    const replacement = after.plans.find((p) => p.id === preview.body.replacementPlanId);
    if (replacement) {
      changes.push(
        ...differences(
          before.plans.find((p) => p.id === target),
          replacement,
        ).filter((row) => row.label !== 'Display name'),
      );
    }
  }
  return (
    <Layout platformName={platformName} username={username} title="Review plan change">
      <SectionStack>
        <h1>Review plan change</h1>
        <p>
          <strong>{preview.affectedAccounts}</strong> existing accounts affected.
        </p>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHeaderCell>Setting</TableHeaderCell>
              <TableHeaderCell>Current</TableHeaderCell>
              <TableHeaderCell>Proposed</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {changes.map((row) => (
              <TableRow key={row.label}>
                <TableHeaderCell>{row.label}</TableHeaderCell>
                <TableCell>{row.before}</TableCell>
                <TableCell>{row.after}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {preview.warnings.map((warning) => (
          <p key={warning} role="alert">
            {warning}
          </p>
        ))}
      </SectionStack>
      {preview.overLimitAccounts.length > 0 && (
        <SectionStack>
          <h2>Accounts above proposed quotas</h2>
          <p>
            This preview samples up to {preview.usageSampleSize} accounts. Other affected accounts
            may also be above the limits.
          </p>
          <ul>
            {preview.overLimitAccounts.map((a) => (
              <li key={a.id}>
                <Link className="void-admin-resource-link" href={`/admin/users/${a.id}`}>
                  {a.login}
                </Link>
                : {a.reasons.map((key) => labels[key as EditablePlanLimit] ?? key).join(', ')}
              </li>
            ))}
          </ul>
        </SectionStack>
      )}
      <SectionStack>
        <p>
          Recorded usage and billing periods are preserved. Lowering quotas can restrict existing
          apps. Raising quotas leaves manual administrator suspensions in place.
        </p>
        <form method="post" action={`${HOME}/apply`} className="void-admin-plan-actions">
          <input type="hidden" name="action" defaultValue={preview.action} />
          <input type="hidden" name="id" defaultValue={target} />
          <input type="hidden" name="revision" defaultValue={preview.expectedRevision} />
          <input type="hidden" name="body" defaultValue={JSON.stringify(preview.body)} />
          <Button
            type="submit"
            label="Apply changes"
            variant={preview.action === 'remove' ? 'destructive' : 'primary'}
          />
          <Button href={HOME} label="Cancel" variant="secondary" />
        </form>
      </SectionStack>
    </Layout>
  );
}

export function PlanProgressPage({
  initial,
  returnTo,
  target,
  platformName,
  username,
}: {
  initial: AdminPlanProgress;
  returnTo: string;
  target?: string;
  platformName: string;
  username?: string;
}) {
  const [state, setState] = useState(initial);
  const [processed, setProcessed] = useState(initial.processed);
  const [running, setRunning] = useState(false);
  useEffect(() => {
    setState(initial);
    setProcessed(initial.processed);
    setRunning(!initial.complete && !initial.error);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let previous = initial;
    async function advance() {
      try {
        const response = await fetch(`${HOME}/sync`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ expectedRevision: initial.revision }),
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(300000)]),
          redirect: 'error',
        });
        if (!response.ok) {
          throw new Error(
            'Account updates paused. Reload plans to inspect the saved configuration, then retry.',
          );
        }
        const next = (await response.json()) as AdminPlanProgress;
        if (
          next.revision !== initial.revision ||
          typeof next.complete !== 'boolean' ||
          !Number.isSafeInteger(next.processed) ||
          next.processed < 0 ||
          (!next.complete &&
            !next.error &&
            (next.processed <= 0 || next.cursor === previous.cursor))
        ) {
          throw new Error('Account updates stopped making progress. Inspect plans, then retry.');
        }
        if (controller.signal.aborted) {
          return;
        }
        setState(next);
        setProcessed((count) => count + next.processed);
        previous = next;
        if (next.complete || next.error) {
          setRunning(false);
        }
        if (next.complete) {
          window.location.replace(returnTo);
          return;
        }
        if (!next.complete && !next.error) {
          timer = setTimeout(() => void advance(), 1000);
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          setRunning(false);
          setState((previous) => ({
            ...previous,
            error:
              error instanceof Error ? error.message : 'Account updates paused. Retry from plans.',
          }));
        }
      }
    }
    if (!initial.complete && !initial.error) {
      void advance();
    }
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [initial, returnTo]);
  return (
    <Layout platformName={platformName} username={username} title="Updating accounts">
      <SectionStack>
        <h1>{state.error ? 'Account updates paused' : 'Updating accounts'}</h1>
        <p role="status">
          {state.complete
            ? 'Account updates complete.'
            : state.error
              ? 'Account updates paused.'
              : 'Updating accounts…'}{' '}
          {processed} accounts updated in this session.
        </p>
        {state.error && <p role="alert">{state.error}</p>}
        {!state.complete && (
          <form method="post" action={`${HOME}/resume`}>
            <input type="hidden" name="revision" defaultValue={state.revision} />
            {target && <input type="hidden" name="id" defaultValue={target} />}
            <Button type="submit" label="Continue account updates" isDisabled={running} />
          </form>
        )}
        <p>
          Usage totals and billing periods are preserved. If you leave this page, you can continue
          any pending updates from Plans.
        </p>
      </SectionStack>
    </Layout>
  );
}
