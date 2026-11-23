import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { VoidActionError } from '../../src/pages/action-result.ts';
import {
  affectedFormErrorKeys,
  changedFormFields,
  formErrorMessage,
  formSubmissionBlocked,
  isFormErrorWithin,
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

describe('changedFormFields', () => {
  it('returns only the values that changed', () => {
    expect(
      changedFormFields(
        { profile: { name: '', email: '' }, contacts: [{ email: '' }, { email: '' }] },
        { profile: { name: 'Alex', email: '' }, contacts: [{ email: '' }, { email: 'a@b' }] },
      ),
    ).toEqual(['profile.name', 'contacts.1.email']);
  });

  it('prefixes the paths with the field the values belong to', () => {
    expect(changedFormFields({ name: '' }, { name: 'Alex' }, 'profile')).toEqual(['profile.name']);
  });

  it('reports an added, removed or replaced value as one path', () => {
    expect(changedFormFields({ name: '' }, {}, 'profile')).toEqual(['profile.name']);
    expect(changedFormFields({}, { name: '' }, 'profile')).toEqual(['profile.name']);
    expect(changedFormFields({ name: '' }, null, 'profile')).toEqual(['profile']);
  });

  it('splits arrays by index', () => {
    expect(changedFormFields(['a'], ['a', 'b'], 'tags')).toEqual(['tags.1']);
  });

  it('keeps a value that is not an array or plain object whole', () => {
    const date = new Date(0);
    expect(changedFormFields({ date }, { date }, 'doc')).toEqual([]);
    expect(changedFormFields({ date }, { date: new Date(1) }, 'doc')).toEqual(['doc.date']);
  });
});

describe('affectedFormErrorKeys', () => {
  const errors = {
    'profile.name': 'Required name',
    'profile.email': 'Required email',
    'contacts.0.email': 'First email',
    'contacts.1.email': 'Second email',
    profile: 'Profile invalid',
    name: 'Unrelated',
  };

  it('keeps the errors of the fields the change did not touch', () => {
    expect(affectedFormErrorKeys(errors, ['contacts.1.email'])).toEqual(['contacts.1.email']);
  });

  it('clears the field that contains the changed value', () => {
    expect(affectedFormErrorKeys(errors, ['profile.name'])).toEqual(['profile.name', 'profile']);
  });

  it('clears the fields below a replaced value', () => {
    expect(affectedFormErrorKeys(errors, ['profile'])).toEqual([
      'profile.name',
      'profile.email',
      'profile',
    ]);
  });
});

describe('isFormErrorWithin', () => {
  it('matches the field and the fields below it', () => {
    expect(isFormErrorWithin('profile', 'profile')).toBe(true);
    expect(isFormErrorWithin('profile.name', 'profile')).toBe(true);
    expect(isFormErrorWithin('profile.name', 'profileName')).toBe(false);
  });
});

describe('omitFormErrors', () => {
  it('removes the field and the fields below it', () => {
    const errors = { profile: 'Invalid', 'profile.name': 'Required', name: 'Required' };
    expect(omitFormErrors(errors, ['profile'])).toEqual({ name: 'Required' });
  });

  it('returns the same map when nothing matched', () => {
    const errors = { name: 'Required' };
    expect(omitFormErrors(errors, ['profile'])).toBe(errors);
  });
});
