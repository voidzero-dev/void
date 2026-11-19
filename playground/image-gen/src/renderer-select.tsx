export type RendererChoice = 'takumi' | 'browser';

export function RendererSelect({ renderer }: { renderer: RendererChoice }) {
  return (
    <label>
      Renderer
      <select
        name="renderer"
        defaultValue={renderer}
        onChange={(event) => event.currentTarget.form?.requestSubmit()}
      >
        <option value="takumi">Takumi</option>
        <option value="browser">Cloudflare Browser Run</option>
      </select>
    </label>
  );
}
