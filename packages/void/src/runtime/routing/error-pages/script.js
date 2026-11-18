(() => {
  const designs = ['signal', 'grid', 'fold'];
  document.documentElement.dataset.design = designs[Math.floor(Math.random() * designs.length)];

  function setup() {
    const back = document.getElementById('void-error-back');
    const canGoBack = window.navigation ? window.navigation.canGoBack : window.history.length > 1;
    if (back && canGoBack) {
      back.hidden = false;
      back.addEventListener('click', () => window.history.back());
    }

    if (document.documentElement.dataset.design !== 'signal') {
      return;
    }
    const canvas = document.querySelector('.error-texture');
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return;
    }

    function draw() {
      const { width, height } = canvas.getBoundingClientRect();
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      const colors = getComputedStyle(canvas);
      const chars = ['·', '/', '0', '1', '+', '[', ']', '—'];
      ctx.font = '8px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = colors.color;

      for (let y = 8, row = 0; y < height; y += 12, row++) {
        for (let x = 8, col = 0; x < width; x += 9, col++) {
          const distance = Math.hypot(
            (x - width / 2) / (width * 0.47),
            (y - height * 0.48) / (height * 0.55),
          );
          const seed = (Math.imul(row + 11, 61) ^ Math.imul(col + 7, 137)) >>> 0;
          const core = Math.max(0, Math.min(1, (distance - 0.28) / 0.55));
          const opacity = core * (0.15 + (seed % 7) * 0.025) * 0.75;
          if (seed % 17 === 0 || opacity < 0.015) {
            continue;
          }
          ctx.globalAlpha = opacity;
          ctx.fillText(chars[(seed >>> 3) % chars.length], x, y);
        }
      }

      ctx.globalAlpha = 1;
      ctx.strokeStyle = colors.borderTopColor;
      for (const [x, y] of [
        [28, 28],
        [width - 28, 28],
        [28, height - 28],
        [width - 28, height - 28],
      ]) {
        ctx.beginPath();
        ctx.moveTo(x - 4, y);
        ctx.lineTo(x + 4, y);
        ctx.moveTo(x, y - 4);
        ctx.lineTo(x, y + 4);
        ctx.stroke();
      }
    }

    new ResizeObserver(draw).observe(canvas);
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', draw);
    draw();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setup, { once: true });
  } else {
    setup();
  }
})();
