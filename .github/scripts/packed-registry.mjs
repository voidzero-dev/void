import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream, readFileSync } from 'node:fs';
import { createServer } from 'node:http';

function isHttpsUrl(value) {
  try {
    return typeof value === 'string' && new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

export function inspectPackage(tarball) {
  const manifest = JSON.parse(
    execFileSync('tar', ['-xOf', tarball, 'package/package.json'], { encoding: 'utf8' }),
  );
  const files = new Set(
    execFileSync('tar', ['-tf', tarball], { encoding: 'utf8' }).trim().split(/\r?\n/),
  );
  assert(
    typeof manifest.description === 'string' && manifest.description.trim().length > 0,
    `${manifest.name}: missing package description`,
  );
  assert.equal(manifest.license, 'MIT', `${manifest.name}: package license must be MIT`);
  assert(isHttpsUrl(manifest.homepage), `${manifest.name}: homepage must be an HTTPS URL`);
  assert(isHttpsUrl(manifest.bugs?.url), `${manifest.name}: bugs.url must be an HTTPS URL`);
  assert(files.has('package/LICENSE'), `${manifest.name}: missing packaged LICENSE`);

  if (manifest.name === 'void') {
    assert.equal(manifest.dependencies?.['takumi-js'], undefined);
    assert.equal(manifest.exports['./image'], undefined);
    assert.equal(manifest.exports['./og'], undefined);
    for (const file of [
      'docs/guide/quickstart.md',
      'docs/reference/cli.md',
      'skills/void/SKILL.md',
      'skills/migrate-vite-cloudflare-to-void/SKILL.md',
      'AGENTS_TEMPLATE.md',
    ]) {
      assert(files.has(`package/${file}`), `void: missing bundled ${file}`);
    }
    assert(
      ![...files].some((file) => file.startsWith('package/skills/void/docs/')),
      'void: docs must be bundled at the package root',
    );
  }

  if (manifest.name === '@void/image') {
    assert(files.has('package/licenses/Inter.txt'), '@void/image: missing Inter license');
    assert.equal(manifest.exports['.'], undefined, '@void/image: root must not export generation');
    assert(manifest.exports['./generate'], '@void/image: missing generate export');
    assert(manifest.peerDependencies?.void, '@void/image: missing void peer dependency');
    assert(manifest.dependencies?.['takumi-js'], '@void/image: missing Takumi dependency');
    const output = execFileSync('tar', ['-xOf', tarball, 'package/dist/generate.mjs'], {
      encoding: 'utf8',
    });
    assert.match(output, /from ["']takumi-js["']/, '@void/image: Takumi must stay external');
    assert.match(output, /import\(["']takumi-js\/wasm["']\)/);
  }

  for (const field of [
    'dependencies',
    'optionalDependencies',
    'peerDependencies',
    'devDependencies',
  ]) {
    for (const [name, version] of Object.entries(manifest[field] ?? {})) {
      assert(
        !/^(workspace:|catalog:|link:|file:)/.test(version),
        `${manifest.name}: unpacked ${field}.${name}=${version}`,
      );
    }
  }
  const checkTarget = (target, bin = false) => {
    if (typeof target === 'string') {
      if (bin || target.startsWith('./')) {
        const path = `package/${target.replace(/^\.\//, '')}`;
        const pattern = new RegExp(
          `^${path
            .split('*')
            .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
            .join('.*')}$`,
        );
        assert(
          [...files].some((file) => pattern.test(file)),
          `${manifest.name}: missing exported file ${target}`,
        );
      }
    } else if (target && typeof target === 'object') {
      Object.values(target).forEach((value) => checkTarget(value, bin));
    }
  };
  checkTarget(manifest.exports);
  checkTarget(manifest.imports);
  checkTarget(manifest.bin, true);
  for (const field of ['main', 'module', 'types']) {
    if (manifest[field]) {
      checkTarget(manifest[field], true);
    }
  }
  return {
    manifest,
    tarball,
    integrity: `sha512-${createHash('sha512').update(readFileSync(tarball)).digest('base64')}`,
  };
}

/** Read-only loopback registry: local release cohort plus public npm dependencies. */
export async function startPackedRegistry(packages) {
  const byName = new Map(packages.map((pkg) => [pkg.manifest.name, pkg]));
  const byFile = new Map(packages.map((pkg, index) => [`/_void_tarball/${index}.tgz`, pkg]));
  const metadata = new Map();
  let metadataBytes = 0;
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.writeHead(405).end();
        return;
      }
      const url = new URL(request.url, 'http://localhost');
      const archive = byFile.get(url.pathname);
      if (archive) {
        response.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        createReadStream(archive.tarball).pipe(response);
        return;
      }
      const name = decodeURIComponent(url.pathname.slice(1));
      const pkg = byName.get(name);
      if (pkg) {
        const path = [...byFile].find(([, entry]) => entry === pkg)[0];
        const version = pkg.manifest.version;
        const body = JSON.stringify({
          name,
          'dist-tags': { latest: version, beta: version, next: version },
          versions: {
            [version]: {
              ...pkg.manifest,
              dist: { tarball: `${origin}${path}`, integrity: pkg.integrity },
            },
          },
        });
        response.writeHead(200, { 'Content-Type': 'application/json' }).end(body);
        return;
      }
      if (
        name === 'void' ||
        name.startsWith('void/') ||
        name === 'create-void' ||
        name.startsWith('create-void/') ||
        name.startsWith('@void/')
      ) {
        // Never let missing local versions silently resolve to a registry release.
        response.writeHead(404).end('Package is outside the packed release cohort.');
        return;
      }
      const upstream = new URL('https://registry.npmjs.org');
      upstream.pathname = url.pathname;
      upstream.search = url.search;
      // Install clients need compact package metadata, not decades of full
      // registry history. Cache a bounded snapshot across independent fixtures.
      const accept = request.headers.accept ?? 'application/vnd.npm.install-v1+json';
      const key = `${accept}\n${upstream.href}`;
      let result = metadata.get(key);
      if (!result) {
        const fetched = await fetch(upstream, {
          headers: { Accept: accept },
          signal: AbortSignal.timeout(30_000),
        });
        result = {
          status: fetched.status,
          type: fetched.headers.get('content-type') ?? 'application/json',
          contents: Buffer.from(await fetched.arrayBuffer()),
        };
        if (result.status === 200 && result.contents.byteLength <= 16 * 1024 * 1024) {
          metadata.set(key, result);
          metadataBytes += result.contents.byteLength;
          while (metadataBytes > 64 * 1024 * 1024) {
            const oldest = metadata.keys().next().value;
            metadataBytes -= metadata.get(oldest).contents.byteLength;
            metadata.delete(oldest);
          }
        }
      }
      response.writeHead(result.status, { 'Content-Type': result.type });
      response.end(result.contents);
    } catch (error) {
      response.writeHead(502).end(String(error));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    async close() {
      server.closeAllConnections();
      server.close();
      await once(server, 'close');
    },
  };
}
