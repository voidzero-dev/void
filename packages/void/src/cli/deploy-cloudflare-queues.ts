import { isRecord } from '@void/deploy-core';
import {
  chooseCloudflareQueueName,
  otherQueueConsumers,
  type CloudflareQueueState,
} from '../queues/cloudflare-names.ts';
import { isCleanCloudflareExit } from './cloudflare-process.ts';
import { type CloudflareDeployDeps } from './deploy-types.ts';
import {
  assertValidResourceName,
  isQueueConfirmedAbsent,
  type DesiredResourceSet,
} from './provision.ts';

function isValidQueueName(name: string): boolean {
  try {
    assertValidResourceName('queue', name);
    return true;
  } catch {
    return false;
  }
}

/**
 * Pick each queue's Cloudflare name from the account's queues and write it into `desired`.
 * Returns the chosen names that do not exist yet, or a message that blocks the deploy.
 */
export async function chooseCloudflareQueueNames(input: {
  desired: DesiredResourceSet;
  workerName: string;
  configPath: string;
  runWrangler: NonNullable<CloudflareDeployDeps['runWrangler']>;
  info: (message: string) => void;
}): Promise<{ ok: true; absent: Array<string> } | { ok: false; message: string }> {
  const { desired, workerName, configPath, runWrangler } = input;
  if (!desired.queueNames) {
    return { ok: true, absent: [] };
  }

  const lookup = async (name: string): Promise<CloudflareQueueState> => {
    const info = await Promise.resolve(
      runWrangler({ type: 'queues.info', name, configPath }, { capture: true }),
    );
    if (isQueueConfirmedAbsent(info)) {
      return null;
    }
    const data = info.data;
    if (
      !isCleanCloudflareExit(info) ||
      !isRecord(data) ||
      data.name !== name ||
      !Array.isArray(data.consumers)
    ) {
      throw new Error(
        `deploy: could not read Cloudflare queue ${name} and its consumers. Retry \`void deploy --platform cloudflare\`.`,
      );
    }
    return { consumers: data.consumers as Array<string | null> };
  };

  // Names come from unsanitized file paths. Report every invalid one before any lookup.
  const invalid = Object.keys(desired.queueNames)
    .filter((queueName) => !isValidQueueName(queueName))
    .map((queueName) => `  • ${queueName} (queue)`);
  if (invalid.length > 0) {
    return {
      ok: false,
      message: [
        'Deploy blocked — these queue names are not valid Cloudflare queue names:',
        ...invalid,
        '',
        'A queue takes its name from its path in queues/; nested segments are joined with "-".',
        'A queue name must be 1–63 characters, contain only letters, digits and "-", and',
        'begin and end with a letter or digit.',
        '',
        'Rename the offending file(s) in queues/ and retry.',
      ].join('\n'),
    };
  }

  const names: Record<string, string> = {};
  const absent: Array<string> = [];
  const tooLong: Array<string> = [];
  const taken: Array<string> = [];
  for (const queueName of Object.keys(desired.queueNames)) {
    const scopedName = desired.queueNames[queueName]!;
    const scoped = isValidQueueName(scopedName) ? await lookup(scopedName) : null;
    // A queue this Worker consumed before queues were named after the Worker keeps its name.
    const plain = scoped?.consumers.includes(workerName) ? undefined : await lookup(queueName);
    const choice = chooseCloudflareQueueName({ workerName, queueName, scoped, plain });
    names[queueName] = choice.name;
    if (!isValidQueueName(choice.name)) {
      tooLong.push(`  • ${choice.name} (${choice.name.length} characters)`);
      continue;
    }
    const state = choice.kept ? plain! : scoped;
    if (state === null) {
      absent.push(choice.name);
    }
    for (const consumer of otherQueueConsumers(state, workerName)) {
      taken.push(
        `  • ${choice.name} is consumed by ${consumer === null ? 'a non-Worker (HTTP pull) consumer' : `Worker ${consumer}`}`,
      );
    }
    if (choice.kept) {
      input.info(
        `Queue ${queueName} keeps its Cloudflare name ${choice.name}, because this Worker already consumes it.`,
      );
    }
  }

  if (tooLong.length > 0) {
    return {
      ok: false,
      message: [
        'Deploy blocked — these Cloudflare queue names are longer than 63 characters:',
        ...tooLong,
        '',
        `A queue's Cloudflare name is the Worker name, "-", then its name from queues/.`,
        'Shorten the Worker name or rename the file(s) in queues/, then retry.',
      ].join('\n'),
    };
  }
  if (taken.length > 0) {
    return {
      ok: false,
      message: [
        `Deploy blocked — Worker ${workerName} cannot consume these queues:`,
        ...taken,
        '',
        'A Cloudflare queue has one consumer. Rename the file in queues/ or the Worker, then retry.',
      ].join('\n'),
    };
  }
  desired.queueNames = names;
  desired.queues = Object.values(names);
  return { ok: true, absent };
}
