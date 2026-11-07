import { createActionClient, type ActionClient } from 'void/pages-client';

const client = createActionClient();

export const action: ActionClient['action'] = client.action;
export const setActionRouter: ActionClient['setActionRouter'] = client.setActionRouter;
