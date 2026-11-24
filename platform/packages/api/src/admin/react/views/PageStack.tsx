/** @jsxImportSource react */

import { SectionStack } from './SectionStack.tsx';
import type { SectionStackProps } from './SectionStack.tsx';

/** Separates independent sections; each section owns its smaller internal gaps. */
export function PageStack({ as = 'div', gap = 8, ...props }: SectionStackProps) {
  return <SectionStack {...props} as={as} gap={gap} />;
}
