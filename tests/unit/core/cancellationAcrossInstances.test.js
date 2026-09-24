import test from 'ava';
import { spawn, fork } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

let server, directory, owner, caller, seq = 0;
const children = [];
function receive(child, predicate) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { child.off('message', handle); reject(new Error('Timed out waiting for instance')); }, 10000);
        function handle(message) {
            if (predicate(message)) { clearTimeout(timer); child.off('message', handle); resolve(message); }
        }
        child.on('message', handle);
    });
}
async function command(child, action, requestId, extra = {}) {
    const id = ++seq;
    const result = receive(child, message => message.seq === id);
    child.send({ seq: id, action, requestId, ...extra });
    const message = await result;
    if (message.error) throw new Error(message.error);
    return message;
}
test.before(async () => {
    directory = await mkdtemp(`${tmpdir()}/cortex-cancel-`);
    const listener = net.createServer();
    await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
    const port = listener.address().port;
    await new Promise(resolve => listener.close(resolve));
    server = spawn('redis-server', ['--port', String(port), '--bind', '127.0.0.1', '--save', '', '--appendonly', 'no', '--dir', directory]);
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.stdout.on('data', data => { if (String(data).toLowerCase().includes('ready to accept connections')) resolve(); });
        server.once('exit', code => reject(new Error(`Redis exited ${code}`)));
    });
    const start = async () => {
        const child = fork(fileURLToPath(new URL('../../helpers/cancellation-instance.js', import.meta.url)), [], {
            env: { ...process.env, STORAGE_CONNECTION_STRING: `redis://127.0.0.1:${port}`, REDIS_ENCRYPTION_KEY: '', CORTEX_CONFIG_FILE: 'config/default.json' },
            stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        });
        children.push(child);
        await receive(child, message => message.ready);
        return child;
    };
    owner = await start(); caller = await start();
});
test.after.always(async () => {
    await Promise.all(children.map(child => new Promise(resolve => { child.once('exit', resolve); child.kill(); })));
    if (server && server.exitCode === null) await new Promise(resolve => { server.once('exit', resolve); server.kill(); });
    if (directory) await rm(directory, { recursive: true, force: true });
});
test.serial('a cancellation received on another instance aborts the owner', async t => {
    await command(owner, 'register', 'remote-request', { deadline: Date.now() + 60000 });
    const aborted = receive(owner, message => message.aborted === 'remote-request');
    const response = await command(caller, 'cancel', 'remote-request');
    t.false(response.hasLocalState);
    await aborted;
    t.pass();
});
test.serial('a cancellation before registration is checked before background execution', async t => {
    await command(caller, 'cancel', 'early-cancel');
    await command(owner, 'register', 'early-cancel', { deadline: Date.now() + 60000 });
    const started = receive(owner, message => message.started === 'early-cancel');
    await command(caller, 'subscribe', 'early-cancel');
    t.true((await started).canceled);
});
