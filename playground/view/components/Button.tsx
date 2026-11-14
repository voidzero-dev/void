import { Label } from './Label.tsx';
export interface ButtonProps {
  label: string;
}
export function Button({ label }: ButtonProps) {
  let pressed = false;
  return (
    <button
      onclick={() => {
        pressed = true;
      }}
    >
      <Label>{pressed ? 'Pressed!' : label}</Label>
    </button>
  );
}

// Deliberately shares a source file with Button: its code must not reach unrelated pages.
export function UnusedButton() {
  return (
    <button
      onclick={() => {
        throw new Error('unused-button-source');
      }}
    >
      Unused example
    </button>
  );
}
