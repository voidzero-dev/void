import { describe, expect, it } from 'vite-plus/test';
import { parseSecretArgs } from '../../src/cli/secret-args.ts';

describe('parseSecretArgs', () => {
  it('parses put with project', () => {
    expect(parseSecretArgs(['put', 'API_KEY', '--project', 'my-app'])).toEqual({
      action: 'put',
      name: 'API_KEY',
      value: undefined,
      projectName: 'my-app',
    });
  });

  it('parses put KEY=value inline form', () => {
    expect(parseSecretArgs(['put', 'API_KEY=abc123'])).toEqual({
      action: 'put',
      name: 'API_KEY',
      value: 'abc123',
      projectName: undefined,
    });
  });

  it('parses delete without project', () => {
    expect(parseSecretArgs(['delete', 'API_KEY'])).toEqual({
      action: 'delete',
      name: 'API_KEY',
      projectName: undefined,
    });
  });

  it('errors on extra delete positional value', () => {
    expect(() => parseSecretArgs(['delete', 'API_KEY', 'extra'])).toThrow(
      'secret: Usage: void secret delete <name> [--project <name>].',
    );
  });

  it('errors on missing put name', () => {
    expect(() => parseSecretArgs(['put'])).toThrow(
      'secret: Usage: void secret put <name> [--project <name>].',
    );
  });

  it('errors on malformed put KEY= form', () => {
    expect(() => parseSecretArgs(['put', 'API_KEY='])).toThrow(
      'secret: Usage: void secret put <name> [--project <name>].',
    );
  });

  it('errors on extra put positional value', () => {
    expect(() => parseSecretArgs(['put', 'API_KEY', 'abc123'])).toThrow(
      'secret: Usage: void secret put <name> [--project <name>].',
    );
  });

  it('parses list without project', () => {
    expect(parseSecretArgs(['list'])).toEqual({
      action: 'list',
      projectName: undefined,
    });
  });

  it('parses list with project', () => {
    expect(parseSecretArgs(['list', '--project', 'my-app'])).toEqual({
      action: 'list',
      projectName: 'my-app',
    });
  });

  it('errors on list with extra positional', () => {
    expect(() => parseSecretArgs(['list', 'extra'])).toThrow(
      'secret: Usage: void secret list [--project <name>].',
    );
  });

  it('errors on unknown action', () => {
    expect(() => parseSecretArgs(['unknown'])).toThrow(
      'secret: Usage: void secret <list|put|delete|sync> ...',
    );
  });

  it('errors on unsupported set action', () => {
    expect(() => parseSecretArgs(['set', 'API_KEY'])).toThrow(
      'secret: Usage: void secret <list|put|delete|sync> ...',
    );
  });

  it('parses sync with file path', () => {
    expect(parseSecretArgs(['sync', '.dev.vars'])).toEqual({
      action: 'sync',
      file: '.dev.vars',
      projectName: undefined,
    });
  });

  it('parses sync with project', () => {
    expect(parseSecretArgs(['sync', '.env', '--project', 'my-app'])).toEqual({
      action: 'sync',
      file: '.env',
      projectName: 'my-app',
    });
  });

  it('errors on missing sync file path', () => {
    expect(() => parseSecretArgs(['sync'])).toThrow(
      'secret: Usage: void secret sync <file> [--project <name>] [--yes].',
    );
  });

  it('errors on extra sync positional', () => {
    expect(() => parseSecretArgs(['sync', '.env', 'extra'])).toThrow(
      'secret: Usage: void secret sync <file> [--project <name>] [--yes].',
    );
  });

  it('parses sync with --yes', () => {
    expect(parseSecretArgs(['sync', '.env', '--yes'])).toEqual({
      action: 'sync',
      file: '.env',
      projectName: undefined,
      yes: true,
    });
  });

  it('rejects --yes on other subcommands', () => {
    expect(() => parseSecretArgs(['list', '--yes'])).toThrow(
      'secret: `void secret list` does not support --yes.',
    );
  });
});
