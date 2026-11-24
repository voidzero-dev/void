interface GoogleFontSource {
  family: string;
  files: ReadonlyArray<{ url: string; weight?: number }>;
}

interface FontPreset {
  id: string;
  family: string;
  google?: GoogleFontSource;
}

const gstatic = 'https://fonts.gstatic.com/s/';

function variable(family: string, path: string): GoogleFontSource {
  return { family, files: [{ url: gstatic + path }] };
}

function fixed(family: string, regular: string, bold?: string): GoogleFontSource {
  const files = [{ url: gstatic + regular, weight: 400 }];
  if (bold) {
    files.push({ url: gstatic + bold, weight: 700 });
  }
  return { family, files };
}

// Latin WOFF2 sources from the Google Fonts CSS API. These are used only by Takumi.
const arimo = variable('Arimo', 'arimo/v36/P5sMzZCDf9_T_10ZxCE.woff2');
const notoSerif = variable(
  'Noto Serif',
  'notoserif/v33/ga6daw1J5X9T9RW6j9bNVls-hfgvz8JcMofYTYf6D30.woff2',
);
const notoSans = variable(
  'Noto Sans',
  'notosans/v42/o-0bIpQlx3QUlC5A4PNB6Ryti20_6n1iPHjc5a7duw.woff2',
);
const roboto = variable('Roboto', 'roboto/v51/KFO7CnqEu92Fr1ME7kSn66aGLdTylUAMa3yUBA.woff2');
const robotoMono = variable('Roboto Mono', 'robotomono/v31/L0x5DF4xlVMF-BfR8bXMIjhLq38.woff2');
const openSans = variable(
  'Open Sans',
  'opensans/v44/memvYaGs126MiZpBA-UvWbX2vVnXBbObj2OVTS-muw.woff2',
);
const sourceSerif = variable(
  'Source Serif 4',
  'sourceserif4/v15/vEFF2_tTDB4M7-auWDN0ahZJW3IX2ih5nk3AucvUHf6kDXr4.woff2',
);
const sourceCode = variable(
  'Source Code Pro',
  'sourcecodepro/v32/HI_SiYsKILxRpg3hIP6sJ7fM7PqlPevW.woff2',
);
const caveat = variable('Caveat', 'caveat/v23/Wnz6HAc5bAfYB2Q7ZjYY.woff2');
const cousine = fixed(
  'Cousine',
  'cousine/v31/d6lIkaiiRdih4SpP_SQvzA.woff2',
  'cousine/v31/d6lNkaiiRdih4SpP9Z8K2TnM0g.woff2',
);
const tinos = fixed(
  'Tinos',
  'tinos/v26/buE4poGnedXvwjX7fmQ.woff2',
  'tinos/v26/buE1poGnedXvwj1AW3Fu0C8.woff2',
);
const anton = fixed('Anton', 'anton/v27/1Ptgg87LROyAm3Kz-C8.woff2');

export const fontGroups: ReadonlyArray<{ label: string; fonts: ReadonlyArray<FontPreset> }> = [
  {
    label: 'Generic CSS families',
    fonts: [
      { id: 'serif', family: 'serif', google: notoSerif },
      { id: 'sans-serif', family: 'sans-serif', google: roboto },
      { id: 'monospace', family: 'monospace', google: robotoMono },
      { id: 'cursive', family: 'cursive', google: caveat },
      {
        id: 'fantasy',
        family: 'fantasy',
        google: fixed('Bangers', 'bangers/v25/FeVQS0BTqb0h60ACH55Q2A.woff2'),
      },
    ],
  },
  {
    label: 'Common system fonts',
    fonts: [
      { id: 'andale-mono', family: 'Andale Mono', google: robotoMono },
      { id: 'arial', family: 'Arial', google: arimo },
      { id: 'arial-black', family: 'Arial Black', google: anton },
      {
        id: 'comic-sans-ms',
        family: 'Comic Sans MS',
        google: fixed(
          'Comic Neue',
          'comicneue/v9/4UaHrEJDsxBrF37olUeD96rp5w.woff2',
          'comicneue/v9/4UaErEJDsxBrF37olUeD_xHM8pxULg.woff2',
        ),
      },
      { id: 'courier', family: 'Courier', google: cousine },
      { id: 'courier-new', family: 'Courier New', google: cousine },
      {
        id: 'georgia',
        family: 'Georgia',
        google: variable('Gelasio', 'gelasio/v14/cIf9MaFfvUQxTTqS9C6hYQ.woff2'),
      },
      { id: 'helvetica', family: 'Helvetica', google: arimo },
      { id: 'impact', family: 'Impact', google: anton },
      {
        id: 'lucida-handwriting',
        family: 'Lucida Handwriting',
        google: fixed('Lobster', 'lobster/v32/neILzCirqoswsqX9zoKmMw.woff2'),
      },
      { id: 'times', family: 'Times', google: tinos },
      { id: 'times-new-roman', family: 'Times New Roman', google: tinos },
      {
        id: 'trebuchet-ms',
        family: 'Trebuchet MS',
        google: variable(
          'Merriweather Sans',
          'merriweathersans/v28/2-c99IRs1JiJN1FRAMjTN5zd9vgsFHX1QjU.woff2',
        ),
      },
      { id: 'verdana', family: 'Verdana', google: openSans },
      { id: 'webdings', family: 'Webdings' },
    ],
  },
  {
    label: 'Open source and extended fonts',
    fonts: [
      { id: 'bitstream-vera-serif', family: 'Bitstream Vera Serif', google: sourceSerif },
      { id: 'bitstream-vera-sans', family: 'Bitstream Vera Sans', google: notoSans },
      { id: 'bitstream-vera-sans-mono', family: 'Bitstream Vera Sans Mono', google: sourceCode },
      { id: 'cyberbit', family: 'Cyberbit', google: notoSerif },
      { id: 'dejavu-serif', family: 'DejaVu Serif', google: sourceSerif },
      { id: 'dejavu-sans', family: 'DejaVu Sans', google: notoSans },
      { id: 'dejavu-sans-mono', family: 'DejaVu Sans Mono', google: sourceCode },
      { id: 'free-serif', family: 'FreeSerif', google: notoSerif },
      { id: 'free-sans', family: 'FreeSans', google: notoSans },
      { id: 'free-mono', family: 'FreeMono', google: cousine },
      {
        id: 'gfs-neohellenic',
        family: 'GFS Neohellenic',
        google: fixed(
          'GFS Neohellenic',
          'gfsneohellenic/v27/8QIRdiDOrfiq0b7R8O1Iw9WLcY5jKqJO.woff2',
          'gfsneohellenic/v27/8QIUdiDOrfiq0b7R8O1Iw9WLcY5rkYdb7IQe.woff2',
        ),
      },
      { id: 'liberation-serif', family: 'Liberation Serif', google: tinos },
      { id: 'liberation-sans', family: 'Liberation Sans', google: arimo },
      { id: 'liberation-mono', family: 'Liberation Mono', google: cousine },
      { id: 'open-sans', family: 'Open Sans', google: openSans },
      { id: 'roboto', family: 'Roboto', google: roboto },
    ],
  },
];

const fontPresets = fontGroups.flatMap((group) => group.fonts);
export const defaultFontId: string = 'sans-serif';

export function getFontPreset(id: string | undefined): FontPreset {
  return (
    fontPresets.find((font) => font.id === id) ??
    fontPresets.find((font) => font.id === defaultFontId)!
  );
}

export function googleFontPage(family: string): string {
  return `https://fonts.google.com/specimen/${family.replaceAll(' ', '+')}`;
}
