/** @jsxImportSource react */
import { CheckboxInput } from '@astryxdesign/core/CheckboxInput';
import { NumberInput } from '@astryxdesign/core/NumberInput';
import { Selector } from '@astryxdesign/core/Selector';
import { TextArea } from '@astryxdesign/core/TextArea';
import { TextInput } from '@astryxdesign/core/TextInput';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type InputHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';

// Astryx forwards native validation attributes, but its field prop types omit them.

export function FormTextInput({
  label,
  name,
  initialValue = '',
  type = 'text',
  required = false,
  maxLength,
  placeholder,
  description,
  isReadOnly,
  autoComplete,
  width,
}: {
  label: string;
  name: string;
  initialValue?: string;
  type?: 'text' | 'password' | 'email' | 'url';
  required?: boolean;
  maxLength?: number;
  placeholder?: string;
  description?: string;
  isReadOnly?: boolean;
  autoComplete?: string;
  width?: number;
}) {
  const [value, setValue] = useState(initialValue);
  useEffect(() => setValue(initialValue), [initialValue]);
  return (
    <TextInput
      label={label}
      htmlName={name}
      value={value}
      onChange={setValue}
      // Astryx forwards the type to the native input but its type union omits url.
      type={type as 'text' | 'password' | 'email'}
      isRequired={required}
      {...({ required, maxLength } satisfies InputHTMLAttributes<HTMLInputElement>)}
      placeholder={placeholder}
      description={description}
      isReadOnly={isReadOnly}
      autoComplete={autoComplete}
      width={width}
    />
  );
}

export function FormTextArea({
  label,
  name,
  initialValue = '',
  required = false,
  placeholder,
  width,
}: {
  label: string;
  name: string;
  initialValue?: string;
  required?: boolean;
  placeholder?: string;
  width?: number;
}) {
  const [value, setValue] = useState(initialValue);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => setValue(initialValue), [initialValue]);
  const resizeToFit = useCallback(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      if (textarea.value) {
        textarea.style.height = `${textarea.scrollHeight}px`;
      }
    }
  }, []);
  useLayoutEffect(resizeToFit, [value, resizeToFit]);
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }
    let width = textarea.clientWidth;
    const observer = new ResizeObserver(() => {
      if (textarea.clientWidth !== width) {
        width = textarea.clientWidth;
        resizeToFit();
      }
    });
    observer.observe(textarea);
    return () => observer.disconnect();
  }, [resizeToFit]);
  return (
    <TextArea
      ref={textareaRef}
      containerClassName="void-admin-autogrow-textarea"
      label={label}
      htmlName={name}
      value={value}
      onChange={setValue}
      isRequired={required}
      {...({ required } satisfies TextareaHTMLAttributes<HTMLTextAreaElement>)}
      placeholder={placeholder}
      rows={1}
      width={width}
    />
  );
}

export function FormSelector({
  label,
  name,
  options,
  initialValue,
  width,
  hasSearch = false,
}: {
  label: string;
  name: string;
  options: Array<{ value: string; label: string }>;
  initialValue: string;
  width?: number;
  hasSearch?: boolean;
}) {
  const [value, setValue] = useState(initialValue);
  useEffect(() => setValue(initialValue), [initialValue]);
  return (
    <Selector
      label={label}
      htmlName={name}
      options={options}
      value={value}
      onChange={setValue}
      width={width}
      hasSearch={hasSearch}
    />
  );
}

export function FormCheckbox({
  label,
  name,
  submitValue,
  initialValue = false,
}: {
  label: string;
  name: string;
  submitValue: string;
  initialValue?: boolean;
}) {
  const [checked, setChecked] = useState(initialValue);
  useEffect(() => setChecked(initialValue), [initialValue]);
  return (
    <>
      <CheckboxInput label={label} value={checked} onChange={setChecked} />
      {checked && <input type="hidden" name={name} value={submitValue} />}
    </>
  );
}

export function FormNumberInput({
  label,
  name,
  width,
  initialValue = null,
  min = 1,
  max,
  required = false,
}: {
  label: string;
  name: string;
  width?: number;
  initialValue?: number | null;
  min?: number;
  max?: number;
  required?: boolean;
}) {
  const [value, setValue] = useState<number | null>(initialValue);
  useEffect(() => setValue(initialValue), [initialValue]);
  return (
    <NumberInput
      label={label}
      htmlName={name}
      value={value}
      onChange={setValue}
      min={min}
      max={max}
      isRequired={required}
      {...({ required } satisfies InputHTMLAttributes<HTMLInputElement>)}
      isIntegerOnly
      hasClear
      width={width}
    />
  );
}
