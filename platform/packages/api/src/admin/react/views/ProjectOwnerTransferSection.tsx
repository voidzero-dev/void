/** @jsxImportSource react */

import { Button } from '@astryxdesign/core/Button';
import { useState } from 'react';
import { AdminUserTypeahead } from './AdminUserTypeahead.tsx';
import type { AdminUserSuggestion } from './AdminUserTypeahead.tsx';
import { SectionStack } from './SectionStack.tsx';

export function ProjectOwnerTransferSection({ projectId }: { projectId: string }) {
  const [selected, setSelected] = useState<AdminUserSuggestion | null>(null);

  return (
    <SectionStack id="owner-transfer" className="void-admin-owner-transfer">
      <h2>Transfer Ownership</h2>
      <p>
        Transfer this project to an existing Void Platform user. You will review the ownership,
        plan, suspension, active-work, routing, and usage-counter changes before applying them.
      </p>
      <SectionStack
        as="form"
        className="void-admin-owner-transfer-form"
        method="post"
        action={`/admin/projects/${projectId}/owner/preview`}
      >
        <AdminUserTypeahead label="New owner" selected={selected} onChange={setSelected} />
        <input type="hidden" name="userId" value={selected?.id ?? ''} />
        <Button type="submit" label="Preview Transfer" isDisabled={!selected} />
      </SectionStack>
    </SectionStack>
  );
}
