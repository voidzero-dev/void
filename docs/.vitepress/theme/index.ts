import monoIcon from '@assets/icons/vite-mono.svg';
import footerBg from '@assets/viteplus/footer-background.jpg';
import BaseTheme, { themeContextKey } from '@voidzero-dev/vitepress-theme';
import { type Theme, useData } from 'vitepress';
import { h } from 'vue';
import CodeGroupSync from './CodeGroupSync.vue';
import 'virtual:group-icons.css';
import './styles.css';
import DocFooter from './DocFooter.vue';
import FileTree from './FileTree.vue';
import PagesFileTree from './PagesFileTree.vue';
import RoutesFileTree from './RoutesFileTree.vue';
import logoDark from './void-dark.svg';
import logoLight from './void-light.svg';
import VoidAppFileTree from './VoidAppFileTree.vue';
import voidzeroLogoDark from './voidzero-logo-dark.svg';
import voidzeroLogoLight from './voidzero-logo-light.svg';

function AsideCredit() {
  const { lang } = useData();
  return h(
    'a',
    {
      href: 'https://voidzero.dev',
      target: '_blank',
      rel: 'noopener noreferrer',
      style: {
        marginTop: '20px',
        border: '1px solid var(--vp-c-divider)',
        borderRadius: '4px',
        padding: '12px 16px',
        fontSize: '13px',
        color: 'var(--vp-c-text-2)',
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        textDecoration: 'none',
      },
    },
    [
      h(
        'span',
        { style: { fontSize: '11px' } },
        lang.value === 'zh-CN' ? '由以下团队打造' : 'brought to you by',
      ),
      h('img', {
        src: voidzeroLogoDark,
        alt: 'VoidZero',
        class: 'aside-credit-logo-dark',
        style: { height: '9px' },
      }),
      h('img', {
        src: voidzeroLogoLight,
        alt: 'VoidZero',
        class: 'aside-credit-logo-light',
        style: { height: '9px', display: 'none' },
      }),
    ],
  );
}

export default {
  extends: BaseTheme,
  Layout() {
    const { localeIndex } = useData();
    // The shared theme captures mobile navigation when the layout mounts.
    return h(BaseTheme.Layout, { key: localeIndex.value }, {
      'aside-ads-before': () => h(AsideCredit),
      'layout-bottom': () => [h(DocFooter), h(CodeGroupSync)],
    });
  },
  enhanceApp({ app }) {
    app.component('FileTree', FileTree);
    app.component('PagesFileTree', PagesFileTree);
    app.component('RoutesFileTree', RoutesFileTree);
    app.component('VoidAppFileTree', VoidAppFileTree);
    app.provide(themeContextKey, {
      logoDark,
      logoLight,
      logoAlt: 'Void',
      footerBg,
      monoIcon,
    });
  },
} satisfies Theme;
