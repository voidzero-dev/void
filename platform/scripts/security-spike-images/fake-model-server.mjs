// Local fake model server for spikes S2/S3 (`--local` mode). Listens on :80 inside a
// Docker network that has no route out; the engine container reaches it as
// `model.scan.internal`. Every request is summarized (no header values) to stdout as one
// JSON line, so the spike script can read the full request log with `docker logs`.
// With FAKE_MODEL_DUMP_DIR set (debugging only), full bodies are written there too.
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fakeModel, summarizeRequest } from './fake-model.mjs';

createServer((request, response) => {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    const bodyText = Buffer.concat(chunks).toString('utf8');
    const path = request.url ?? '/';
    const host = request.headers.host ?? '';
    const reply = fakeModel({ method: request.method, path, bodyText });
    const summary = summarizeRequest({
      method: request.method,
      path,
      headers: request.headers,
      bodyText,
    });
    console.log(JSON.stringify({ fakeModelRequest: { host, status: reply.status, ...summary } }));
    if (process.env.FAKE_MODEL_DUMP_DIR) {
      writeFileSync(
        `${process.env.FAKE_MODEL_DUMP_DIR}/${Date.now()}-${request.method}.json`,
        bodyText,
      );
    }
    setTimeout(() => {
      response.writeHead(reply.status, { 'content-type': reply.contentType });
      response.end(reply.text);
    }, reply.delayMs ?? 0);
  });
}).listen(80, () => console.log(JSON.stringify({ fakeModelListening: 80 })));
