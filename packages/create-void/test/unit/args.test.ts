import { describe, expect, it } from 'vite-plus/test';
import { parseCreateArgs, validateProjectName } from '../../src/args.ts';

describe('parseCreateArgs', () => {
  it('forwards options after the project name to void init', () => {
    expect(parseCreateArgs(['my-app', '--framework', 'react', '--deploy=none'])).toEqual({
      appName: 'my-app',
      initArgs: ['--framework', 'react', '--deploy=none'],
    });
  });

  it('forwards every argument when no project name is given', () => {
    expect(parseCreateArgs(['--framework', 'vue'])).toEqual({
      appName: undefined,
      initArgs: ['--framework', 'vue'],
    });
    expect(parseCreateArgs([])).toEqual({ appName: undefined, initArgs: [] });
  });

  it.each(['MyApp', 'my-App', 'MY-APP'])('rejects an uppercase project name: %s', (name) => {
    expect(() => parseCreateArgs([name])).toThrow('create-void: Project name must be lowercase');
  });

  it.each([
    'my_app',
    'my.app',
    'my app',
    'nested/my-app',
    'my-app-',
    'a'.repeat(64),
  ])('rejects invalid project names from the command line: %s', (name) => {
    expect(() => parseCreateArgs([name])).toThrow('create-void: Project name');
  });

  it.each(['a', '0', 'my-app', 'my--app', 'app123', 'a'.repeat(63)])(
    'accepts deployable project names from the command line: %s',
    (name) => {
      expect(parseCreateArgs([name])).toEqual({ appName: name, initArgs: [] });
    },
  );

  it('rejects arguments that are not plain flags or values', () => {
    expect(() => parseCreateArgs(['my-app', '--framework', 'react&calc'])).toThrow(
      "create-void: Unsupported argument 'react&calc'.",
    );
  });
});

describe('validateProjectName', () => {
  it.each(['MyApp', 'my-App', 'MY-APP'])('rejects uppercase names: %s', (name) => {
    expect(validateProjectName(name)).toBe('Project name must be lowercase');
  });

  it.each(['a', '0', 'my-app', 'my--app', 'app123', 'a'.repeat(63)])(
    'accepts lowercase names: %s',
    (name) => {
      expect(validateProjectName(name)).toBeUndefined();
    },
  );

  it.each([
    'my_app',
    'my.app',
    'my app',
    ' my-app',
    'my-app ',
    'my-app\n',
    'my-app\t',
    'my-app\u0000',
    'café',
    '项目',
    'my😀app',
    'nested/my-app',
    'nested\\my-app',
    '@scope/my-app',
    '.',
    '..',
    '../my-app',
    '/tmp/my-app',
    'my&app',
    'my;app',
    'my$app',
  ])('rejects characters outside the Cloudflare name alphabet: %j', (name) => {
    expect(validateProjectName(name)).toBe(
      'Project name must contain only lowercase letters, numbers, and dashes',
    );
  });

  it.each(['-app', 'app-', '-', '--'])('rejects leading or trailing dashes: %s', (name) => {
    expect(validateProjectName(name)).toBe('Project name cannot start or end with a dash');
  });

  it('rejects names longer than a workers.dev DNS label', () => {
    expect(validateProjectName('a'.repeat(64))).toBe('Project name must be at most 63 characters');
  });

  it('allows the prompt default and rejects whitespace-only names', () => {
    expect(validateProjectName(undefined)).toBeUndefined();
    expect(validateProjectName('')).toBeUndefined();
    expect(validateProjectName('   ')).toBe('Project name cannot be blank');
  });
});
