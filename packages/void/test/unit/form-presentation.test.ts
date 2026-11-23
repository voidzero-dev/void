import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { VoidActionError } from '../../src/pages/action-result.ts';
import {
  changedFormErrorKeys,
  formErrorMessage,
  formSubmissionBlocked,
  formErrorKeysWithin,
  omitFormErrors,
  scheduleFormRetry,
} from '../../src/pages/form-presentation.ts';
const error = () =>
  new VoidActionError({
    status: 429,
    statusText: '',
    url: '/',
    body: {
      code: 'usage_limit',
      resource: 'ai',
      reason: 'rate_limit',
      message: 'Please try later',
      retryAt: new Date(Date.now() + 2000).toISOString(),
    },
  });
afterEach(() => vi.useRealTimers());
it('preserves field errors and uses the server-provided quota message', () => {
  expect(formErrorMessage({ error: null, errors: { name: 'Name is required' } })).toBe(
    'Name is required',
  );
  expect(formErrorMessage({ error: error(), errors: {} })).toBe('Please try later');
});
it('blocks only while pending or until a known retry deadline, without submitting', async () => {
  vi.useFakeTimers();
  const form = { pending: false, error: error() };
  const ready = vi.fn();
  const cancel = scheduleFormRetry(form.error, ready);
  expect(formSubmissionBlocked(form)).toBe(true);
  await vi.advanceTimersByTimeAsync(2000);
  expect(ready).toHaveBeenCalledOnce();
  expect(formSubmissionBlocked(form)).toBe(false);
  cancel();
  const cancelNext = scheduleFormRetry(error(), ready);
  cancelNext();
  await vi.advanceTimersByTimeAsync(2000);
  expect(ready).toHaveBeenCalledOnce();
});

describe('changedFormErrorKeys', () => {
  const errors = {
    contacts: 'More contacts required',
    'contacts.0.email': 'First email invalid',
    'contacts.1.email': 'Second email invalid',
    'contacts.1.name': 'Second name required',
  };
  const twoContacts = { contacts: [{ email: '' }, { email: '', name: '' }] };

  it('selects the changed child and its ancestor but keeps unchanged siblings', () => {
    expect(
      changedFormErrorKeys(errors, twoContacts, {
        contacts: [{ email: 'valid@example.com' }, { email: '', name: '' }],
      }),
    ).toEqual(['contacts', 'contacts.0.email']);
  });

  it('selects the descendants of a removed row', () => {
    expect(changedFormErrorKeys(errors, twoContacts, { contacts: [{ email: '' }] })).toEqual([
      'contacts',
      'contacts.1.email',
      'contacts.1.name',
    ]);
  });

  it('clears a missing descendant when its container is replaced', () => {
    const errors = { 'profile.name': 'Required' };
    expect(changedFormErrorKeys(errors, { profile: {} }, { profile: null })).toEqual([
      'profile.name',
    ]);
    expect(changedFormErrorKeys(errors, { profile: {} }, { profile: { email: '' } })).toEqual([]);
  });

  it('keeps a literal dotted field separate from a nested path', () => {
    const before = { email: { personal: '' }, 'email.work': '' };
    const errors = { 'email.personal': 'Invalid', 'email.work': 'Invalid' };
    expect(
      changedFormErrorKeys(errors, before, {
        ...before,
        email: { personal: 'valid@example.com' },
      }),
    ).toEqual(['email.personal']);
    expect(changedFormErrorKeys(errors, before, { email: before.email })).toEqual(['email.work']);
  });

  it('treats undefined fields and array entries as present', () => {
    const before = { profile: { nickname: undefined }, contacts: [undefined] };
    expect(
      changedFormErrorKeys(
        { profile: 'Invalid', 'profile.nickname': 'Invalid', contacts: 'Too short' },
        before,
        { profile: {}, contacts: [undefined, undefined] },
      ),
    ).toEqual(['profile', 'profile.nickname', 'contacts']);
    expect(
      changedFormErrorKeys(
        { contacts: 'Invalid', 'contacts.0': 'Invalid' },
        { contacts: new Array<undefined>(1) },
        { contacts: [undefined] },
      ),
    ).toEqual(['contacts', 'contacts.0']);
  });

  it('keeps a non-plain object whole', () => {
    const date = new Date(0);
    const errors = { date: 'Invalid date' };
    expect(changedFormErrorKeys(errors, { date }, { date })).toEqual([]);
    expect(changedFormErrorKeys(errors, { date }, { date: new Date(1) })).toEqual(['date']);
  });
});

describe('formErrorKeysWithin', () => {
  const data = { email: { personal: '' }, 'email.work': '' };
  const errors = { email: 'Invalid', 'email.personal': 'Required', 'email.work': 'Required' };

  it('selects a parent and its descendants, preserving flat dotted fields', () => {
    expect(formErrorKeysWithin(errors, ['email'], data)).toEqual(['email', 'email.personal']);
    expect(formErrorKeysWithin(errors, ['email.work'], data)).toEqual(['email.work']);
  });

  it('finds descendant errors for a missing optional parent', () => {
    expect(formErrorKeysWithin({ 'profile.name': 'Required' }, ['profile'], {})).toEqual([
      'profile.name',
    ]);
  });
});

describe('omitFormErrors', () => {
  const errors = { profile: 'Invalid', 'profile.name': 'Required' };

  it('removes the exact keys selected for an edit', () => {
    expect(omitFormErrors(errors, ['profile'])).toEqual({ 'profile.name': 'Required' });
  });

  it('returns the same map with no keys to remove', () => {
    expect(omitFormErrors(errors, [])).toBe(errors);
  });
});
