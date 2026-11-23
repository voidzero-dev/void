type Example = {
  title: string;
  description: string;
  code: string;
  expected: string;
};

export const examples = {
  'local-images': {
    title: 'Local images',
    description: 'Use a public URL or import a file with its intrinsic dimensions.',
    code: `import lake from '../../assets/lake.jpg?image';\n\n<Image src="/images/lake.jpg" alt={lakeAlt} width={1440} height={960} />\n<Image src={lake} alt={lakeAlt} />`,
    expected: 'Both use the optimizer. The import supplies width and height without extra props.',
  },
  'responsive-sizing': {
    title: 'Responsive sizing',
    description: 'Compare density candidates for a fixed image with width candidates for fill.',
    code: `<Image src={lake} alt={lakeAlt} width={320} height={213} />\n<Image src={lake} alt={lakeAlt} fill\n  sizes="(max-width: 800px) 90vw, 60vw" style={{ objectFit: 'cover' }} />`,
    expected:
      'Switch modes and resize the viewport. Compare the rendered width and selected URL; browsers may reuse a larger candidate already in cache.',
  },
  loading: {
    title: 'Loading and placeholders',
    description: 'Preload a hero, then scroll to a lazy image with a blur placeholder.',
    code: `<Image src={lake} alt={lakeAlt} width={1440} height={960} preload />\n<Image src={portrait} alt={lakeAlt} width={720} height={960}\n  loading="lazy" placeholder="blur" blurDataURL={placeholder} />`,
    expected:
      'Open the Network panel in DevTools, then scroll toward the second image and watch for the lake-portrait.jpg request.',
  },
  'art-direction': {
    title: 'Art direction',
    description: 'Use getImageProps() and <picture> to switch between wide and portrait crops.',
    code: `<picture>\n  <source media="(min-width: 800px)" srcSet={wide.srcSet} sizes={wide.sizes} />\n  <img {...tall} />\n</picture>`,
    expected:
      'Cross the 800px breakpoint and watch both the crop and the selected source URL change.',
  },
  'remote-images': {
    title: 'Remote images',
    description: 'Allow one URL and see how the optimizer responds to a URL that does not match.',
    code: `// void.config.ts\nimages: { remotePatterns: [new URL(remoteImage)] }\n\n// In a page\n<Image src={remoteImage} alt={lakeAlt} width={1440} height={960} />`,
    expected:
      'The allowed image renders. The rejected example changes the query, so the exact URL pattern no longer matches and the optimizer returns HTTP 400.',
  },
  'quality-and-format': {
    title: 'Quality and format',
    description: 'Compare an optimized image with the original and inspect format negotiation.',
    code: `<Image src={lake} alt={lakeAlt} width={480} height={320} quality={quality} />\n<Image src={lake} alt={lakeAlt} width={480} height={320} unoptimized />`,
    expected:
      'Try different qualities and Accept headers. Compare the returned content type and bytes rather than assuming the requested format was used.',
  },
} satisfies Record<string, Example>;

export type ExampleId = keyof typeof examples;
