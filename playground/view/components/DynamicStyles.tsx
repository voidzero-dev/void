export function Swatch({ color }: { color: string }) {
  return (
    <p class="swatch">
      Dynamic styles alone make this a Web Component.
      <style>{`.swatch { color: ${color}; }`}</style>
    </p>
  );
}

export function DynamicStyles({ initial }: { initial: string }) {
  let color = initial;
  let size = 20;
  return (
    <section class="dynamic-styles">
      <h2>Instance color: {color}</h2>
      <button
        onclick={() => {
          color = 'purple';
          size += 4;
        }}
      >
        Change style
      </button>
      <Swatch color="green" />
      <style>{`
        section { border: 1px solid; padding: 24px; margin: 24px 0; }
      `}</style>
      <style>{`
        h2 { color: ${color}; font-size: ${size}px; }
      `}</style>
      <style>{`section { border-color: ${color}; }`}</style>
    </section>
  );
}
