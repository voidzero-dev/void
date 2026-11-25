// The four scanner tools, described once for every engine that calls them by name
// (Engine B's chat-completions loop and Engine C's `void-scan` MCP server).

import { submitFindingsParameters } from '../report.ts';

const PATH_HELP =
  'An absolute path under /scan/input or /scan/memory, or a path relative to /scan/input.';

export function scanToolDefinitions(): Array<{
  name: 'read_file' | 'list_files' | 'grep' | 'submit_findings';
  description: string;
  parameters: Record<string, unknown>;
}> {
  return [
    {
      name: 'read_file',
      description: `Read lines of a text file. ${PATH_HELP} Lines come back numbered.`,
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['path'],
        properties: {
          path: { type: 'string' },
          offset: { type: 'integer', minimum: 1, description: 'First line, from 1.' },
          limit: { type: 'integer', minimum: 1, maximum: 2000, description: 'Lines to read.' },
        },
      },
    },
    {
      name: 'list_files',
      description: `List files and folders. ${PATH_HELP} Defaults to /scan/input.`,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { path: { type: 'string' }, recursive: { type: 'boolean' } },
      },
    },
    {
      name: 'grep',
      description: `Find lines that contain a plain text string (not a regular expression). ${PATH_HELP} Defaults to /scan/input.`,
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['pattern'],
        properties: {
          pattern: { type: 'string', minLength: 1, maxLength: 200 },
          path: { type: 'string' },
          case_insensitive: { type: 'boolean' },
          max_results: { type: 'integer', minimum: 1, maximum: 500 },
        },
      },
    },
    {
      name: 'submit_findings',
      description:
        'Submit the final report. Call it exactly once, when you are done. It ends the session.',
      parameters: submitFindingsParameters(),
    },
  ];
}
