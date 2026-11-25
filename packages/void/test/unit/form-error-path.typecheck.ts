import type { FormErrors, FormState } from '../../src/pages/form-presentation.ts';

type Body = {
  profile: { name: string; avatar: File | null; email: string & { readonly brand: 'Email' } };
  contacts: Array<{ email: string }>;
  tags: Map<string, string>;
  sections: Array<{ rows: Array<{ cells: Array<{ value: string }> }> }>;
};

export const nested: FormErrors<Body> = {
  profile: 'Required profile',
  'profile.name': 'Required name',
  'contacts.0.email': 'Required email',
  // Deeper than six segments: accepted, without completion.
  'sections.0.rows.0.cells.0.value': 'Required value',
};
// @ts-expect-error A nested path must name a field in the body.
export const typo: FormErrors<Body> = { 'profile.nme': 'Invalid' };
// @ts-expect-error Array segments are indices.
export const arrayName: FormErrors<Body> = { 'contacts.first': 'Invalid' };
// @ts-expect-error A file is one field.
export const fileProperty: FormErrors<Body> = { 'profile.avatar.size': 'Invalid' };
// @ts-expect-error A branded string is one field.
export const brandProperty: FormErrors<Body> = { 'profile.email.length': 'Invalid' };
// @ts-expect-error A map is one field.
export const mapProperty: FormErrors<Body> = { 'tags.size': 'Invalid' };

// A body with several self references stays cheap to check.
type Person = {
  name: string;
  parent: Person;
  spouse: Person;
  manager: Person;
  friends: Array<Person>;
  children: Array<Person>;
};
export function checkRecursiveBody(form: FormState<Person, 'in-place'>): string | undefined {
  form.setError('parent.name', 'Required name');
  form.clearErrors('friends.0.name', 'name');
  // @ts-expect-error A top-level field must exist.
  form.setError('nme', 'Invalid');
  return form.errors.name;
}

export function checkGenericField<T, K extends keyof T & string>(
  form: FormState<T, 'in-place'>,
  field: K,
): string | undefined {
  form.setError(field, 'Invalid');
  form.clearErrors(field);
  return form.errors[field];
}

// A child is cut only when it is the same type as an ancestor, not one that matches it
// through optional fields.
type Draft = {
  name?: string;
  owner?: { name?: string; email?: string };
  children?: Array<{ name: string }>;
};
export const draft: FormErrors<Draft> = { 'owner.email': 'Invalid', 'children.0.name': 'Invalid' };
// @ts-expect-error A typo below an all-optional child is still rejected.
export const draftTypo: FormErrors<Draft> = { 'owner.emial': 'Invalid' };
// @ts-expect-error A typo in an array item is still rejected.
export const itemTypo: FormErrors<Draft> = { 'children.0.nmae': 'Invalid' };
