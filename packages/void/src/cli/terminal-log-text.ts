// A whole CSI sequence (ESC [, parameter bytes, intermediate bytes, final byte),
// a whole OSC sequence of printable text ended by BEL or ESC \, or one C0/C1
// control character other than tab and newline.
const TERMINAL_CONTROL =
  // eslint-disable-next-line no-control-regex -- matching control characters is the point
  /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0000-\u001f\u007f-\u009f]*(?:\u0007|\u001b\\)|[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const SGR = /^\u001b\[[0-9;:]*m$/;

/**
 * Make app log text safe to print to a terminal. App logs often echo request
 * data from anonymous visitors, so escape sequences in them must not reach the
 * terminal as commands (clipboard writes, hyperlinks, screen clears, cursor
 * moves or carriage-return overwrites).
 *
 * SGR color codes, newlines and tabs are kept so ordinary colored or
 * multi-line logs read the same. A text that keeps any SGR code ends with a
 * reset, so styles such as conceal cannot hide the lines printed after it.
 * Every other complete CSI or OSC sequence is removed whole, so a hyperlink
 * shows only its visible text and a line clear leaves no stray "[K". Every
 * other C0/C1 control character is dropped on its own; an escape sequence that
 * is incomplete, such as an OSC with no terminator, loses only its control
 * characters and the rest prints as plain text instead of being swallowed.
 *
 * Keep this module free of imports: the Cloudflare operation process is a
 * separate bundle entry that must stay small.
 */
export function sanitizeTerminalLogText(value: string): string {
  let keptStyle = false;
  const text = value.replaceAll(TERMINAL_CONTROL, (match) => {
    if (!SGR.test(match)) {
      return '';
    }
    keptStyle = true;
    return match;
  });
  return keptStyle ? `${text}\u001b[0m` : text;
}
