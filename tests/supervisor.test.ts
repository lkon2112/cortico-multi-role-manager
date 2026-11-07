import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Supervisor } from '../src/supervisor.ts';
import { configure } from '../src/adapter.ts';
import { writeJson } from '../src/io.ts';

function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'manager-supervisor-'));
    const source = join(root, 'official'), data = join(root, 'manager'), dir = join(data, 'deployments/probe');
    mkdirSync(join(source, 'bin'), { recursive: true });
    mkdirSync(dir, { recursive: true });
    writeJson(join(dir, 'config.json'), { displayName: 'Probe' });
    writeJson(join(dir, 'deployment.json'), { bot: 'cormini' });
    writeJson(join(dir, '.manager.json'), { port: 19301 });
    writeFileSync(join(source, 'bin/cortico.mjs'), `
        import { fork } from 'node:child_process';
        import { writeFileSync } from 'node:fs';
        const child = fork('bin/core.mjs', process.argv.slice(2));
        process.on('SIGTERM', () => {}); // Same ownership pattern as the official launcher.
        child.on('message', () => writeFileSync('ready.json', JSON.stringify([process.pid, child.pid])));
        child.on('exit', code => process.exit(code ?? 1));
    `);
    writeFileSync(join(source, 'bin/core.mjs'), `
        import http from 'node:http';
        import { existsSync } from 'node:fs';
        if (!existsSync('healthy')) {
            process.on('SIGTERM', () => {}); // Exercise bounded cleanup of an unresponsive Core.
            setInterval(() => {}, 1000);
            process.send('ready');
        } else {
            const port = Number(process.argv.find(v => v.startsWith('--port=')).slice(7));
            const server = http.createServer((req, res) => {
                res.setHeader('content-type', 'application/json');
                if (req.url === '/api/auth/login') res.setHeader('set-cookie', 'test=ready');
                res.end(JSON.stringify({ displayName: 'Probe', loop: { paused: true } }));
                if (req.url === '/api/run/shutdown') server.close(() => process.exit(0));
            });
            server.listen(port, '127.0.0.1');
        }
    `);
    configure({ source, root: data });
    return { root, source, dir, supervisor: new Supervisor(data, 19300, '127.0.0.1') };
}

test('startup timeout reaps the launcher and Core, then permits a successful retry', { timeout: 20000 }, async t => {
    const { root, source, supervisor } = fixture();
    const realNow = Date.now;
    try {
        t.mock.timers.enable({ apis: ['Date'] });
        const pending = assert.rejects(supervisor.start('probe'), /启动超时/);
        const deadline = realNow() + 5000;
        while (!existsSync(join(source, 'ready.json'))) {
            assert.ok(realNow() < deadline, 'Fixture Core did not start');
            await new Promise(r => setTimeout(r, 20));
        }
        const pids: number[] = JSON.parse(readFileSync(join(source, 'ready.json'), 'utf8'));
        t.mock.timers.tick(91000);
        await pending;
        t.mock.timers.reset();
        for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
        assert.equal(supervisor.role('probe').state, 'error');
        assert.match(supervisor.role('probe').error!, /启动超时/);
        supervisor.assertStopped('probe');
        writeFileSync(join(source, 'healthy'), '');
        await supervisor.start('probe');
        assert.equal(supervisor.role('probe').state, 'paused');
        await supervisor.stop('probe');
        assert.equal(supervisor.role('probe').state, 'stopped');
    } finally {
        t.mock.timers.reset();
        await supervisor.close();
        rmSync(root, { recursive: true, force: true });
    }
});

test('replacing an existing avatar changes the role revision', () => {
    const { root, dir, supervisor } = fixture();
    try {
        const path = join(dir, 'avatar.png');
        writeFileSync(path, 'first image');
        utimesSync(path, 1000, 1000);
        const before = supervisor.role('probe');
        writeFileSync(path, 'other image');
        utimesSync(path, 1001, 1001);
        const after = supervisor.role('probe');
        assert.equal(before.avatar, true);
        assert.equal(after.avatar, true);
        assert.notEqual(before.avatarVersion, after.avatarVersion);
        rmSync(path);
        assert.equal(supervisor.role('probe').avatar, false);
    } finally { rmSync(root, { recursive: true, force: true }); }
});
