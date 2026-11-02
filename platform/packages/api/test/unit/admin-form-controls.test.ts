import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vite-plus/test';
import {
  FormNumberInput,
  FormTextArea,
  FormTextInput,
} from '../../src/admin/react/views/FormControls.tsx';

it('preserves native required validation on admin form controls', () => {
  const props = { label: 'Name', name: 'name', required: true };
  for (const control of [
    createElement(FormTextInput, props),
    createElement(FormTextArea, props),
    createElement(FormNumberInput, props),
  ]) {
    const markup = renderToStaticMarkup(control);
    expect(markup).toMatch(/<(?:input|textarea)\b[^>]*\srequired=""/);
    expect(markup).toContain('aria-required="true"');
  }
});

it('preserves the browser length limit on text inputs', () => {
  const markup = renderToStaticMarkup(
    createElement(FormTextInput, { label: 'Name', name: 'name', maxLength: 64 }),
  );
  expect(markup).toMatch(/<input\b[^>]*\smaxLength="64"/);
  expect(markup).not.toMatch(/\srequired=""/);
});
