/** @jsxImportSource react */

import { Stack } from '@astryxdesign/core/Stack';
import type { StackProps } from '@astryxdesign/core/Stack';
import type { FormHTMLAttributes } from 'react';

export type SectionStackProps = StackProps &
  Pick<FormHTMLAttributes<HTMLFormElement>, 'action' | 'method'>;

/** Groups a section's heading, copy, content, and actions without additive margins. */
export function SectionStack({ as = 'section', gap = 4, className, ...props }: SectionStackProps) {
  return (
    <Stack
      {...props}
      as={as}
      gap={gap}
      className={['void-admin-stack', className].filter(Boolean).join(' ')}
    />
  );
}
