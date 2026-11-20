// Scanner runner entry (`dist/runner.mjs`). The controller starts it with a short
// argv and streams the input tar on stdin (spike S1/S1b: no long argv, no reads
// of /run/cloudchamber). Exit code 0 means status.json was written, whatever the
// scan status; 1 means even that failed.
//
//   node runner.mjs [--root /scan] [--stdin-tar] [--model-base-url http://model.void.internal]
//   node runner.mjs --self-test   (probe checks 2 and 3; prints one JSON line)

import { parseArgs } from 'node:util';
import { MODEL_BASE_URL } from './engines/void-loop.ts';
import { extractTar, ExtractError } from './extract.ts';
import { runScan } from './run.ts';
import { runSelfTest } from './self-test.ts';

const INPUT_ROOTS = ['task.json', 'input', 'memory'];

async function main(argv: Array<string>): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      root: { type: 'string', default: '/scan' },
      'stdin-tar': { type: 'boolean', default: false },
      'model-base-url': { type: 'string', default: MODEL_BASE_URL },
      'self-test': { type: 'boolean', default: false },
      // Tests only: replace the self-test egress targets.
      'egress-target': { type: 'string', multiple: true },
    },
    strict: true,
  });
  if (values['self-test']) {
    const targets = values['egress-target'];
    const report = await runSelfTest({
      baseUrl: values['model-base-url'],
      targets: targets
        ? Object.fromEntries(targets.map((url, index) => [`target${index}`, url]))
        : undefined,
    });
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return 0;
  }
  const root = values.root;
  const controller = new AbortController();
  // The controller's wall-clock stop: end the session and still write status.json.
  // It also stops a tar that is still coming in; runScan then writes timed_out.
  process.once('SIGTERM', () => {
    controller.abort();
    process.stdin.destroy();
  });

  let startError: { errorClass: string; message: string } | undefined;
  if (values['stdin-tar']) {
    try {
      await extractTar(process.stdin, {
        dest: root,
        allowedRoots: INPUT_ROOTS,
        signal: controller.signal,
      });
    } catch (error) {
      startError = {
        errorClass: 'input_invalid',
        message:
          error instanceof ExtractError ? error.message : 'the scan input could not be unpacked',
      };
    } finally {
      // An open stdin would keep the process alive after status.json is written.
      process.stdin.destroy();
    }
  }

  const status = await runScan({
    root,
    baseUrl: values['model-base-url'],
    signal: controller.signal,
    startError,
  });
  process.stdout.write(`${JSON.stringify({ status: status.status, reason: status.reason })}\n`);
  return 0;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`scanner runner failed: ${error instanceof Error ? error.name : 'error'}\n`);
  process.exitCode = 1;
}
