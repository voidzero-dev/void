function FutureText() {
  return <strong>Only rendered after clicking</strong>;
}
function FutureContent() {
  return <aside>{FutureText()}</aside>;
}
export function Reveal() {
  let visible = false;
  return (
    <section>
      <button
        onclick={() => {
          visible = true;
        }}
      >
        Reveal content
      </button>
      {visible ? <FutureContent /> : null}
    </section>
  );
}
