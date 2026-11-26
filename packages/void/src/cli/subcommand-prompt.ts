import {
  S_STEP_SUBMIT,
  S_BAR,
  S_BAR_END,
  S_RADIO_ACTIVE,
  S_RADIO_INACTIVE,
  S_CHECKBOX_SELECTED,
  getGuide,
  promptTitle,
  optionText,
  wrapTextWithPrefix,
  formatInstructionFooter,
  SELECT_INSTRUCTIONS,
  MULTISELECT_INSTRUCTIONS,
  S_CHECKBOX_INACTIVE,
} from '@voidzero-dev/vite-plus-prompts';
import { wrapAnsi } from 'fast-wrap-ansi';
import { pc } from './output.ts';

export type FlagDef = {
  name: string; // e.g. "--output" (include dashes)
  description: string;
  arg?: string; // e.g. "<path>" — flag takes a value
};

export type FollowUpDef =
  | {
      type: 'multi-select';
      flag: string;
      options: Array<{ value: string; label: string; selected?: boolean }>;
    }
  | {
      type: 'repeat-input';
      placeholder: string;
    };

export type SubcommandDef = {
  name: string;
  description: string;
  arg?: string; // e.g. "<name>" — shown as dim hint, enables inline text input
  hint?: string; // e.g. "login | logout | whoami" — shown dim after name
  flags?: Array<FlagDef>;
  followUp?: FollowUpDef;
};

export type SubcommandResult = {
  subcommand: string;
  arg?: string;
  flags?: Record<string, string | true>;
  extraArgs?: Array<string>;
};

const isUpKey = (key: string) => key === '\u001B[A' || key === '\u001BOA';
const isDownKey = (key: string) => key === '\u001B[B' || key === '\u001BOB';
const isEnterKey = (key: string) => key === '\r' || key === '\n';
const isBackspaceKey = (key: string) => key === '\u007F' || key === '\b';
const isPrintableKey = (key: string) => key.length === 1 && key >= ' ';

function checkboxMarker(selected: boolean, focused: boolean): string {
  const checkbox = selected
    ? pc.blue(S_CHECKBOX_SELECTED)
    : focused
      ? pc.blue(S_CHECKBOX_INACTIVE)
      : pc.dim(S_CHECKBOX_INACTIVE);
  const pointer = focused ? pc.blue(S_RADIO_ACTIVE) : S_RADIO_INACTIVE;
  return pointer + ' ' + checkbox;
}

function guidePrefix(): string {
  return getGuide() ? pc.gray(S_BAR) + ' ' : '  ';
}

export function promptSubcommand(
  command: string,
  subcommands: Array<SubcommandDef>,
): Promise<SubcommandResult | null> {
  return new Promise((resolve) => {
    const { stdin, stdout } = process;

    type Phase = 'select' | 'flags' | 'multi-select' | 'repeat-input';
    let phase: Phase = 'select';
    let cursor = 0;
    let input = '';
    let previousFrame = '';
    let resolved = false;

    let selectedSub: SubcommandDef | null = null;
    let selectedArg: string | undefined;
    const selectedFlags: Record<string, string | true> = {};
    let flagStates: Array<{ enabled: boolean; value: string }> = [];
    let multiSelectStates: Array<boolean> = [];
    let repeatEntries: Array<string> = [];
    let repeatInput = '';

    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    stdout.write('\u001B[?25l'); // hide cursor

    function clear() {
      if (previousFrame) {
        const rows = wrapAnsi(previousFrame, stdout.columns || 80, {
          hard: true,
          trim: false,
        }).split('\n').length;
        stdout.write(`\u001B[${rows}A\r\u001B[0J`);
        previousFrame = '';
      }
    }

    function truncate(text: string, columns = (stdout.columns || 80) - 1, tail = false): string {
      const width = Math.max(1, columns - 1);
      const wrap = (value: string) => wrapAnsi(value, width, { hard: true, trim: false });
      const lines = wrap(text).split('\n');
      if (lines.length === 1) {
        return lines[0];
      }
      if (tail) {
        const suffix = Array.from(text).slice(-width);
        while (wrap(suffix.join('')).includes('\n')) {
          suffix.shift();
        }
        return `…${suffix.join('')}`;
      }
      return `${lines[0]}…`;
    }

    function renderOption(marker: string, label: string, focused: boolean, suffix = ''): string {
      return (
        guidePrefix() +
        optionText(
          stdout,
          marker + ' ',
          label,
          focused ? (value) => pc.blue(pc.bold(value)) : pc.dim,
          suffix,
        )
      );
    }

    function instructions(items: Array<string>): Array<string> {
      return formatInstructionFooter(items, getGuide(), stdout);
    }

    function writeFrame(header: string, options: Array<string>, footer: Array<string>) {
      const heading = header.trimEnd().split('\n');
      const end = getGuide() ? [pc.gray(S_BAR_END)] : [];
      // Keep each option on one row, with focus visible in short terminals.
      const count = Math.max(
        1,
        Math.min(7, (stdout.rows || 24) - heading.length - footer.length - end.length - 1),
      );
      const start = Math.max(0, Math.min(cursor - Math.floor(count / 2), options.length - count));
      const lines = [
        ...heading.map((line) => truncate(line)),
        ...options.slice(start, start + count).map((option) => truncate(option)),
        ...footer.map((line) => truncate(line)),
        ...end,
      ];
      previousFrame = lines.join('\n');
      stdout.write(previousFrame + '\n');
    }

    function render() {
      if (resolved) {
        return;
      }
      clear();
      if (phase === 'select') {
        renderSelect();
      } else if (phase === 'flags') {
        renderFlags();
      } else if (phase === 'multi-select') {
        renderMultiSelect();
      } else {
        renderRepeatInput();
      }
    }

    const title = command ? `void ${command}` : 'void';

    function selectedSubcommand(): SubcommandDef {
      if (!selectedSub) {
        throw new Error('No subcommand selected.');
      }
      return selectedSub;
    }

    function headerLine(): string {
      const argPart = selectedArg ? ` ${selectedArg}` : '';
      return promptTitle(
        `${pc.blue(title)} ${pc.dim('·')} ${selectedSubcommand().name}${argPart}`,
        'active',
        { output: stdout },
      );
    }

    function renderSelect() {
      const lines: Array<string> = [];
      const focused = subcommands[cursor];

      const maxName = Math.max(...subcommands.map((s) => s.name.length));

      for (let i = 0; i < subcommands.length; i++) {
        const sub = subcommands[i];
        const isFocused = i === cursor;
        const radio = isFocused ? pc.blue(S_RADIO_ACTIVE) : pc.dim(S_RADIO_INACTIVE);
        const name = sub.name.padEnd(maxName);

        let suffix = '';
        if (isFocused && sub.arg) {
          if (isFocused && input.length > 0) {
            suffix = `  ${pc.blue(truncate(input, (stdout.columns || 80) - maxName - 9, true))}`;
          } else {
            suffix = `  ${pc.dim(sub.arg)}`;
          }
        } else if (isFocused && sub.hint) {
          suffix = `  ${pc.dim(sub.hint)}`;
        }

        lines.push(renderOption(radio, name, isFocused, suffix));
      }

      const footer = [
        guidePrefix() + pc.dim(focused.description),
        ...instructions(SELECT_INSTRUCTIONS),
      ];
      if (focused.arg) {
        if (focused.arg.startsWith('<')) {
          footer.push(`${guidePrefix()}${pc.dim(`Type ${focused.arg}, then press Enter`)}`);
        } else {
          footer.push(
            `${guidePrefix()}${pc.dim(`Type ${focused.arg}, then press Enter, or press Enter to skip`)}`,
          );
        }
      }
      writeFrame(promptTitle(pc.blue(title), 'active', { output: stdout }), lines, footer);
    }

    function renderFlags() {
      const { flags } = selectedSubcommand();
      if (!flags?.length) {
        throw new Error('The selected subcommand has no flags.');
      }
      const focused = flags[cursor];
      const lines: Array<string> = [];

      const maxFlag = Math.max(...flags.map((f) => f.name.length));

      for (let i = 0; i < flags.length; i++) {
        const flag = flags[i];
        const state = flagStates[i];
        const isFocused = i === cursor;
        const name = flag.name.padEnd(maxFlag);

        let valueText = '';
        if (flag.arg) {
          if (state.enabled && state.value.length > 0) {
            const value = truncate(state.value, (stdout.columns || 80) - maxFlag - 9, true);
            valueText = `  ${isFocused ? pc.blue(value) : pc.dim(value)}`;
          } else {
            valueText = `  ${pc.dim(flag.arg)}`;
          }
        }

        lines.push(
          renderOption(checkboxMarker(state.enabled, isFocused), name, isFocused, valueText),
        );
      }

      writeFrame(headerLine(), lines, [
        guidePrefix() + pc.dim(focused.description),
        ...instructions(MULTISELECT_INSTRUCTIONS),
      ]);
    }

    function renderMultiSelect() {
      const { followUp } = selectedSubcommand();
      if (followUp?.type !== 'multi-select') {
        throw new Error('The selected subcommand has no multi-select options.');
      }
      const options = followUp.options;
      const lines: Array<string> = [];

      const maxLabel = Math.max(...options.map((o) => o.label.length));

      for (let i = 0; i < options.length; i++) {
        const isFocused = i === cursor;
        const label = options[i].label.padEnd(maxLabel);
        lines.push(renderOption(checkboxMarker(multiSelectStates[i], isFocused), label, isFocused));
      }

      writeFrame(headerLine(), lines, instructions(MULTISELECT_INSTRUCTIONS));
    }

    function renderRepeatInput() {
      const { followUp } = selectedSubcommand();
      if (followUp?.type !== 'repeat-input') {
        throw new Error('The selected subcommand has no repeat input.');
      }
      const lines: Array<string> = [];

      for (const entry of repeatEntries) {
        lines.push(`${guidePrefix()}${pc.dim(entry)}`);
      }

      if (repeatInput.length > 0) {
        lines.push(
          `${guidePrefix()}${pc.blue(truncate(repeatInput, (stdout.columns || 80) - 4, true))}`,
        );
      } else {
        lines.push(`${guidePrefix()}${pc.dim(followUp.placeholder)}`);
      }

      cursor = lines.length - 1;
      writeFrame(headerLine(), lines, instructions(['Enter add', 'Empty input finish']));
    }

    function cleanup() {
      if (resolved) {
        return;
      }
      resolved = true;
      stdin.setRawMode(wasRaw);
      stdin.pause();
      stdin.removeListener('data', onData);
      stdout.removeListener('resize', render);
      process.removeListener('exit', onExit);
      stdout.write('\u001B[?25h');
    }

    function submit(result: SubcommandResult | null) {
      cleanup();
      clear();

      if (result) {
        let summary = result.subcommand;
        if (result.arg) {
          summary += ` ${result.arg}`;
        }
        if (result.flags) {
          for (const [flag, value] of Object.entries(result.flags)) {
            summary += ` ${flag}`;
            if (typeof value === 'string') {
              summary += ` ${value}`;
            }
          }
        }
        if (result.extraArgs && result.extraArgs.length > 0) {
          summary += ` ${result.extraArgs.join(' ')}`;
        }
        stdout.write(
          wrapTextWithPrefix(
            stdout,
            `${pc.dim(title)} ${pc.dim('·')} ${pc.dim(summary)}`,
            '  ',
            `${pc.gray(S_STEP_SUBMIT)} `,
          ) + '\n',
        );
      }

      resolve(result);
    }

    function finalize() {
      const result: SubcommandResult = {
        subcommand: selectedSubcommand().name,
        arg: selectedArg,
      };

      if (Object.keys(selectedFlags).length > 0) {
        result.flags = { ...selectedFlags };
      }

      if (repeatEntries.length > 0) {
        result.extraArgs = repeatEntries;
      }

      submit(result);
    }

    function advancePhase() {
      const { flags, followUp } = selectedSubcommand();
      // After choosing a command, try flags first.
      if (phase === 'select' && flags?.length) {
        phase = 'flags';
        cursor = 0;
        flagStates = flags.map(() => ({ enabled: false, value: '' }));
        render();
        return;
      }

      // Then try any follow-up input phase.
      if ((phase === 'select' || phase === 'flags') && followUp) {
        if (followUp.type === 'multi-select') {
          phase = 'multi-select';
          cursor = 0;
          multiSelectStates = followUp.options.map((o) => !!o.selected);
          render();
          return;
        }
        if (followUp.type === 'repeat-input') {
          phase = 'repeat-input';
          repeatEntries = [];
          repeatInput = '';
          render();
          return;
        }
      }

      finalize();
    }

    function moveCursor(key: string, length: number): boolean {
      if (isUpKey(key)) {
        cursor = cursor === 0 ? length - 1 : cursor - 1;
        return true;
      }
      if (isDownKey(key)) {
        cursor = (cursor + 1) % length;
        return true;
      }
      return false;
    }

    function handleSelectKey(key: string) {
      const focused = subcommands[cursor];

      if (moveCursor(key, subcommands.length)) {
        input = '';
        render();
        return;
      }

      if (isEnterKey(key)) {
        const argRequired = focused.arg && focused.arg.startsWith('<');
        if (argRequired && input.length === 0) {
          return;
        }
        selectedSub = focused;
        selectedArg = focused.arg ? input || undefined : undefined;
        advancePhase();
        return;
      }

      if (isBackspaceKey(key)) {
        if (focused.arg && input.length > 0) {
          input = input.slice(0, -1);
          render();
        }
        return;
      }

      if (focused.arg && isPrintableKey(key)) {
        input += key;
        render();
      }
    }

    function handleFlagKey(key: string) {
      const { flags } = selectedSubcommand();
      if (!flags?.length) {
        throw new Error('The selected subcommand has no flags.');
      }
      const focused = flags[cursor];
      const state = flagStates[cursor];

      if (moveCursor(key, flags.length)) {
        render();
        return;
      }

      if (key === ' ') {
        state.enabled = !state.enabled;
        if (!state.enabled) {
          state.value = '';
        }
        render();
        return;
      }

      if (isEnterKey(key)) {
        // An enabled value flag needs a value before advancing.
        for (let i = 0; i < flags.length; i++) {
          if (flagStates[i].enabled && flags[i].arg && flagStates[i].value.length === 0) {
            return;
          }
        }
        for (let i = 0; i < flags.length; i++) {
          if (flagStates[i].enabled) {
            selectedFlags[flags[i].name] = flags[i].arg ? flagStates[i].value : true;
          }
        }
        advancePhase();
        return;
      }

      if (isBackspaceKey(key)) {
        if (focused.arg && state.enabled && state.value.length > 0) {
          state.value = state.value.slice(0, -1);
          render();
        }
        return;
      }

      // Typing a value enables its flag.
      if (focused.arg && isPrintableKey(key)) {
        state.enabled = true;
        state.value += key;
        render();
      }
    }

    function handleMultiSelectKey(key: string) {
      const { followUp } = selectedSubcommand();
      if (followUp?.type !== 'multi-select') {
        throw new Error('The selected subcommand has no multi-select options.');
      }
      const options = followUp.options;

      if (moveCursor(key, options.length)) {
        render();
        return;
      }

      if (key === ' ') {
        multiSelectStates[cursor] = !multiSelectStates[cursor];
        render();
        return;
      }

      if (isEnterKey(key)) {
        const selected = options.filter((_, i) => multiSelectStates[i]);
        if (selected.length === 0) {
          return;
        }
        selectedFlags[followUp.flag] = selected.map((o) => o.value).join(',');
        finalize();
        return;
      }
    }

    function handleRepeatInputKey(key: string) {
      // Enter adds the typed entry; Enter on empty input finishes.
      if (isEnterKey(key)) {
        if (repeatInput.length > 0) {
          repeatEntries.push(repeatInput);
          repeatInput = '';
          render();
        } else {
          finalize();
        }
        return;
      }

      if (isBackspaceKey(key)) {
        if (repeatInput.length > 0) {
          repeatInput = repeatInput.slice(0, -1);
          render();
        }
        return;
      }

      if (isPrintableKey(key)) {
        repeatInput += key;
        render();
      }
    }

    function handleKey(key: string) {
      if (resolved) {
        return;
      }

      if (phase === 'select') {
        handleSelectKey(key);
      } else if (phase === 'flags') {
        handleFlagKey(key);
      } else if (phase === 'multi-select') {
        handleMultiSelectKey(key);
      } else {
        handleRepeatInputKey(key);
      }
    }

    function onData(data: Buffer) {
      if (resolved) {
        return;
      }
      const key = data.toString();

      // Ctrl+C
      if (key === '\u0003') {
        submit(null);
        return;
      }
      // Escape
      if (key === '\u001B' && data.length === 1) {
        submit(null);
        return;
      }
      // Arrow keys and other escape sequences need to stay grouped.
      if (key.startsWith('\u001B')) {
        handleKey(key);
        return;
      }

      for (const char of key) {
        if (char === '\u0003') {
          submit(null);
          return;
        }
        handleKey(char);
      }
    }

    stdin.on('data', onData);
    stdout.on('resize', render);

    // Safety cleanup on exit
    function onExit() {
      if (!resolved) {
        stdout.write('\u001B[?25h');
      }
    }
    process.on('exit', onExit);

    render();
  });
}
