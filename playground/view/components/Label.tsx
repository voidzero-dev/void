import type { BaseProps } from '@void/view';
export function Label({ children }: BaseProps) {
  return (
    <>
      <span class="label">{children}</span>
      <style>{`.label { font-weight: bold; }`}</style>
    </>
  );
}
