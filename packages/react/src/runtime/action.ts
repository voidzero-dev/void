import { createActionClient, type ActionClient } from 'void/pages-client';

// React Actions must finish before their page update can commit.
const client = createActionClient({ _resolveOnShell: true });

export const action: ActionClient['action'] = client.action;
export const setActionRouter: ActionClient['setActionRouter'] = client.setActionRouter;
