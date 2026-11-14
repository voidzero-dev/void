export function StyledChild() {
  return (
    <div class="styled-child">
      <h2>Child heading</h2>
      <style>{`h2 { color: rgb(0, 0, 255); }`}</style>
    </div>
  );
}

export function StyledPanel() {
  let count = 0;
  return (
    <section class="card styled-panel">
      <h2 class="local-heading">Local heading: {count}</h2>
      <button
        onclick={() => {
          count++;
        }}
      >
        Update styled component
      </button>
      {count > 0 ? <h2 class="new-heading">New heading after rerender</h2> : null}
      <StyledChild />
      <style>{`
        .card {
          background: white;
          border: 1px solid #d6dfd1;
          border-radius: 12px;
          padding: 24px;
          margin: 24px 0;
        }
        h2 { color: rgb(255, 0, 0); }
        h2::before { content: "Scoped: "; }
        :root { .global-nested { color: rgb(128, 0, 128); } }
        :root .global-flat { color: rgb(0, 128, 0); }
      `}</style>
    </section>
  );
}
