import type {
  FooterColumn,
  FooterConfig,
  FooterLink,
  FooterSocialLink,
} from '../../types/theme-config.ts';

type FooterNavProps = Readonly<{
  footer?: FooterConfig;
}>;

export default function FooterNav({ footer }: FooterNavProps) {
  const footerNav: ReadonlyArray<FooterColumn> = footer?.nav ?? [];
  const footerSocial: ReadonlyArray<FooterSocialLink> = footer?.social ?? [];
  const footerCopyright =
    // oxlint-disable-next-line react/purity -- Compute the default copyright year at render time.
    footer?.copyright || `© ${new Date().getFullYear()} VoidZero Inc. All Rights Reserved.`;

  return (
    <>
      <section className="wrapper wrapper--ticks dashboard-footer">
        <div className="dashboard-footer-nav">
          <div className="dashboard-footer-columns">
            {footerNav.map((column) => (
              <div key={column.title}>
                <p className="dashboard-footer-title">{column.title}</p>
                <ul className="dashboard-footer-links">
                  {column.items.map((item: FooterLink) => (
                    <li key={item.link}>
                      <a className="dashboard-footer-link" href={item.link}>
                        {item.text}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          {footerSocial.length ? (
            <div>
              <p className="dashboard-footer-title">Social</p>
              <ul className="dashboard-footer-links">
                {footerSocial.map((social) => (
                  <li key={social.link}>
                    <a
                      className="dashboard-footer-link dashboard-social-link"
                      href={social.link}
                      rel="noopener noreferrer"
                      target="_blank"
                    >
                      <span
                        aria-hidden="true"
                        className="dashboard-social-icon"
                        style={{ maskImage: `url("${social.icon}")` }}
                      />
                      {social.label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </section>
      <section className="wrapper wrapper--ticks dashboard-footer dashboard-footer-copyright">
        <p>{footerCopyright}</p>
      </section>
    </>
  );
}
