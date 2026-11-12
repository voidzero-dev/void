import type { CloudContext } from 'void/handler';

export const statusMessages = {
  401: 'Please sign in',
  403: 'Your account is banned',
  404: 'This page does not exist',
  410: 'This page is permanently gone',
  429: 'Too many requests',
  500: 'Unexpected loader failure',
  503: 'Down for maintenance',
} as const

export function parseStatus(c: CloudContext) {
  return parseInt(c.req.param('status')!) as keyof typeof statusMessages;
}
