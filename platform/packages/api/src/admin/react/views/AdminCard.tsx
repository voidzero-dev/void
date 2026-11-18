/** @jsxImportSource react */

import { Card } from '@astryxdesign/core/Card';
import { ClickableCard } from '@astryxdesign/core/ClickableCard';
import { Layout, LayoutContent, LayoutFooter, LayoutHeader } from '@astryxdesign/core/Layout';
import { Heading, Text } from '@astryxdesign/core/Text';
import { ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { SectionStack } from './SectionStack.tsx';

export function AdminCard({
  title,
  titleId,
  headingLevel = 2,
  titleIcon,
  description,
  href,
  headerAccessory,
  children,
  footer,
}: {
  title: string;
  titleId?: string;
  headingLevel?: 2 | 3;
  titleIcon?: ReactNode;
  description?: ReactNode;
  href?: string;
  headerAccessory?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
}) {
  const content = (
    <Layout
      height="auto"
      header={
        <LayoutHeader hasDivider padding={0}>
          <div className="void-admin-card-heading">
            <div className="void-admin-card-title">
              <Heading level={headingLevel} id={titleId}>
                {titleIcon ? (
                  <span className="void-admin-card-label">
                    {titleIcon}
                    {title}
                  </span>
                ) : (
                  title
                )}
              </Heading>
              {headerAccessory}
              {href && (
                <ChevronRight className="void-admin-card-arrow" size={18} aria-hidden="true" />
              )}
            </div>
          </div>
        </LayoutHeader>
      }
      content={
        (description != null || children != null) && (
          <LayoutContent>
            <SectionStack as="div" className="void-admin-card-content">
              {description != null && (
                <Text as="p" type="body">
                  {description}
                </Text>
              )}
              {children}
            </SectionStack>
          </LayoutContent>
        )
      }
      footer={
        footer != null && (
          <LayoutFooter hasDivider className="void-admin-card-footer">
            {footer}
          </LayoutFooter>
        )
      }
    />
  );
  if (href) {
    return (
      <ClickableCard className="void-admin-card" label={title} href={href}>
        {content}
      </ClickableCard>
    );
  }
  return <Card className="void-admin-card">{content}</Card>;
}
