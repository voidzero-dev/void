/** @jsxImportSource @voidcloud/api/admin-jsx */

import { Link } from '@astryxdesign/core/Link';

export function ProjectUrlLink({ url }: { url: string }) {
  return (
    <Link as="a" className="void-admin-url" href={url} isExternalLink hasUnderline tooltip={url}>
      {url.replace(/^https:\/\//, '')}
    </Link>
  );
}
