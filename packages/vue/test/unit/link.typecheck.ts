import { h } from 'vue';
import { Link } from '../../src/runtime/link.ts';

type LinkProps = InstanceType<typeof Link>['$props'];

export function checkLinkPassThroughAttributes(): void {
  const track = (event: MouseEvent) => void event;
  const props: LinkProps = {
    href: '/users',
    target: '_blank',
    download: 'report.pdf',
    rel: 'noopener',
    onClick: track,
    onMouseenter: () => {},
    activeMatch: 'prefix',
  };
  void h(Link, props);
  // @ts-expect-error href is required
  const missingHref: LinkProps = { target: '_blank' };
  // @ts-expect-error Void props keep their own types
  const badPrefetch: LinkProps = { href: '/users', prefetch: 'sometimes' };
  // @ts-expect-error activeMatch is exact or prefix
  const badActiveMatch: LinkProps = { href: '/users', activeMatch: 'nested' };
  void [missingHref, badPrefetch, badActiveMatch];
}
