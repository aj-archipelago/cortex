import test from 'ava';
import http from 'node:http';
import fs from 'node:fs';
import sinon from 'sinon';
import { downloadFile } from '../../../lib/fileUtils.js';

async function server(t, handler) {
    const instance = http.createServer(handler);
    await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve));
    t.teardown(() => new Promise(resolve => { instance.closeAllConnections(); instance.close(resolve); }));
    return `http://127.0.0.1:${instance.address().port}/audio.mp3`;
}

test.serial('download deadline closes a stalled connection and removes the partial file', async t => {
    let closed;
    const disconnected = new Promise(resolve => { closed = resolve; });
    const url = await server(t, (_req, response) => {
        response.on('close', closed);
        response.writeHead(200);
        response.write('partial');
    });
    const files = sinon.spy(fs, 'createWriteStream');
    t.teardown(() => files.restore());
    await t.throwsAsync(downloadFile(url, { timeoutMs: 100 }), { name: 'AbortError' });
    await disconnected;
    t.is(files.callCount, 1);
    t.false(fs.existsSync(files.firstCall.args[0]));
});

test.serial('successful bounded download returns complete media and rejects HTTP failures', async t => {
    const url = await server(t, (req, response) => {
        response.writeHead(req.url.includes('missing') ? 404 : 200);
        response.end('audio');
    });
    const file = await downloadFile(url, { timeoutMs: 1000 });
    t.teardown(() => fs.promises.rm(file, { force: true }));
    t.is(await fs.promises.readFile(file, 'utf8'), 'audio');
    await t.throwsAsync(downloadFile(`${url}?missing`, { timeoutMs: 1000 }), { message: /404/ });
});
