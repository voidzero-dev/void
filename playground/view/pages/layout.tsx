import type { BaseProps } from '@void/view';

export default function Layout({ children }: BaseProps) {
  return (
    <>
      <main>{children}</main>
      <style>{`
        main {
          max-width: 850px;
          padding: 48px 24px;
          margin: auto;
        }
        :root {
          font: 17px/1.6 system-ui, sans-serif;
          color: #24352c;
          background: #f2f5ef;
          body { margin: 0; }
          h1 { font-size: 48px; letter-spacing: -2px; margin-bottom: 8px; }
          h2 { font-size: 21px; }
          a { color: #315d38; }
          button {
            padding: 10px 16px;
            margin: 4px;
            border: 1px solid #809b83;
            border-radius: 6px;
            background: #e9f3e4;
            color: inherit;
            cursor: pointer;
            font: inherit;
          }
        }
      `}</style>
    </>
  );
}
