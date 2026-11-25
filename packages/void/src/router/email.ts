/**
 * Scan `email/` for inbound email handlers.
 *
 * The `email/` directory sits at the source root alongside `crons/` and
 * `queues/` — non-HTTP handlers all live at the top level, since each is
 * wired into a separate worker export (`scheduled`, `queue`, `email`).
 *
 *   email/<local-part>.ts        per-recipient handler matched against the
 *                                 local-part of the To address
 *   email/<local-part>+[tag].ts  same, with a `+suffix` capture exposed as
 *                                 `info.params.<tag>`
 *   email/[name].ts              dynamic local-part — captures the whole
 *                                 local-part as `info.params.<name>`
 *   email/[name]+[tag].ts        dynamic + tag
 *   email/_default.ts            fallback when no per-address pattern matches
 *
 * Match precedence (most specific wins):
 *   static + tag → static → dynamic + tag → dynamic → _default
 * Within a kind a literal tag beats a captured tag (`support+vip` before
 * `support+[tag]`, `[user]+vip` before `[user]+[tag]`); the same shape sorts
 * alphabetically. See `compareEmailRoutes`.
 *
 * Local-part matching is case-insensitive: the compiled patterns carry the `i`
 * flag and run against the recipient in its original case, so a captured tag
 * such as a ticket id keeps the case it arrived with. Nested folders are
 * intentionally ignored — the recipient address is a single string, not a path.
 */

import { join } from 'pathslash';
import { globSync } from 'tinyglobby';
import { compareEmailRoutes, compileEmailPattern } from '../shared/email-pattern.ts';
import type { CompiledEmailPattern } from '../shared/email-pattern.ts';

const EMAIL_EXTENSIONS = ['ts', 'mts', 'js', 'mjs'];

export interface EmailHandlerDefinition {
  /** Original basename without extension, e.g. "support" or "support+[ticket]". */
  address: string;
  /** Path relative to the email directory, e.g. "support.ts". */
  filePath: string;
  /** Compiled match pattern. */
  pattern: CompiledEmailPattern;
}

export interface EmailHandlersScan {
  /** Per-address handlers under email/, sorted by specificity then name. */
  addresses: Array<EmailHandlerDefinition>;
  /** email/_default.<ext> — fires when no per-address pattern matches. */
  defaultHandler?: string;
}

type ParsedEmailFiles = {
  addresses: Array<EmailHandlerDefinition>;
  defaultHandler?: string;
};

function parseEmailFiles(files: Array<string>): ParsedEmailFiles {
  const addresses: Array<EmailHandlerDefinition> = [];
  let defaultHandler: string | undefined;

  for (const filePath of files) {
    if (filePath.includes('/')) {
      continue;
    }
    const basename = filePath.replace(/\.[^.]+$/, '');
    // `_default` is a reserved filename and is matched exactly: `_Default.ts`
    // or `_default.test.ts` fall through to the `_`-prefix skip below like
    // any other private helper. Two `_default.<ext>` files (e.g. `.ts` next
    // to `.js` mid-migration) would otherwise resolve to whichever the glob
    // returned last — readdir order, not stable across filesystems — with
    // the other silently unbundled. Reject, mirroring the regex-collision
    // check on per-address handlers below.
    if (basename === '_default') {
      if (defaultHandler !== undefined) {
        throw new Error(
          `email handler "${filePath}" is a second default handler next to "${defaultHandler}" — keep exactly one email/_default.* file.`,
        );
      }
      defaultHandler = filePath;
      continue;
    }
    if (basename.startsWith('_')) {
      continue;
    }
    const pattern = compileEmailPattern(basename);
    if (!pattern) {
      continue;
    }
    addresses.push({
      address: basename.toLowerCase(),
      filePath,
      pattern,
    });
  }

  addresses.sort(compareEmailRoutes);

  // Two handlers can compile to the same regex source — the obvious case
  // is `[user].ts` and `[other].ts` both producing `^([^+@]+)$`. After
  // alphabetical sort, the first one wins for every delivery and the
  // others are dead code. Reject at scan time with a clear error rather
  // than letting the deployment ship a silent footgun.
  const seenRegex = new Map<string, string>();
  for (const def of addresses) {
    const prior = seenRegex.get(def.pattern.regexSource);
    if (prior !== undefined) {
      throw new Error(
        `email handler "${def.filePath}" matches the same address shape as "${prior}" (both compile to ${def.pattern.regexSource}). Rename one of them — only the alphabetically-first would ever fire.`,
      );
    }
    seenRegex.set(def.pattern.regexSource, def.filePath);
  }

  return { addresses, defaultHandler };
}

export function scanEmailHandlersSync(root: string, emailDir = 'email'): EmailHandlersScan {
  const pattern = `*.{${EMAIL_EXTENSIONS.join(',')}}`;
  return parseEmailFiles(globSync(pattern, { cwd: join(root, emailDir) }));
}

export function hasEmailHandlers(scan: EmailHandlersScan): boolean {
  return scan.addresses.length > 0 || Boolean(scan.defaultHandler);
}
