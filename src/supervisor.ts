import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { existsSync, statSync, mkdirSync, readdirSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { source, environment, profile } from './adapter.ts';
import { json, validId } from './io.ts';
import type { Role, RunState } from './types.ts';
type Entry = {
    child: ChildProcess;
    port: number;
    password: string;
    cookie: string;
    state: RunState;
    error?: string;
    restartPid?: number;
    exit: Promise<number | null>;
};
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
// The official launcher owns a Core child. Clean up only our failed launch tree.
async function terminateStartup(p: Entry) {
    if (!p.child.pid || p.child.exitCode !== null || p.child.signalCode !== null)
        return;
    if (process.platform === 'win32') {
        await promisify(execFile)('taskkill', ['/PID', String(p.child.pid), '/T', '/F']);
        await p.exit;
        return;
    }
    const signal = (value: NodeJS.Signals) => {
        try { process.kill(-p.child.pid!, value); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    };
    signal('SIGTERM');
    const timer = setTimeout(() => signal('SIGKILL'), 5000);
    try { await p.exit; }
    finally { clearTimeout(timer); }
}
export async function portAvailable(port: number, host: string): Promise<boolean> {
    return new Promise((resolve, reject) => {
        const server = createServer();
        server.once('error', (e: NodeJS.ErrnoException) => e.code === 'EADDRINUSE' ? resolve(false) : reject(e));
        server.listen(port, host, () => server.close(() => resolve(true)));
    });
}
async function localPort(): Promise<number> {
    const server = createServer();
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const port = (server.address() as {
        port: number;
    }).port;
    await new Promise<void>(resolve => server.close(() => resolve()));
    return port;
}
export class Supervisor {
    readonly home: string;
    private processes = new Map<string, Entry>();
    private busy = new Set<string>();
    private allocation: Promise<unknown> = Promise.resolve();
    constructor(readonly root: string, readonly managerPort: number, readonly host: string) {
        this.home = join(root, 'deployments');
        mkdirSync(this.home, { recursive: true });
        mkdirSync(join(root, 'logs'), { recursive: true });
    }
    roles(): Role[] {
        return readdirSync(this.home, { withFileTypes: true })
            .filter(e => e.isDirectory() && validId(e.name) && existsSync(join(this.home, e.name, '.manager.json')))
            .map(e => {
            const dir = join(this.home, e.name), cfg = json<any>(join(dir, 'config.json'), {}), proc = this.processes.get(e.name);
            const avatar = statSync(join(dir, 'avatar.png'), { throwIfNoEntry: false });
            return { id: e.name, name: cfg.displayName || e.name, bot: json(join(dir, 'deployment.json')).bot,
                port: json(join(dir, '.manager.json')).port, cloned: !!json(join(dir, '.manager.json')).clone,
                avatar: !!avatar, avatarVersion: avatar?.mtimeMs, state: proc?.state ?? 'stopped', error: proc?.error };
        });
    }
    role(id: string): Role { const r = this.roles().find(r => r.id === id); if (!r)
        throw Error('找不到角色'); return r; }
    async exclusive<T>(id: string, fn: () => Promise<T>): Promise<T> {
        if (this.busy.has(id))
            throw Error('这个角色正在执行操作，请稍后再试');
        this.busy.add(id);
        try {
            return await fn();
        }
        finally {
            this.busy.delete(id);
        }
    }
    withAvailablePort<T>(fn: (port: number) => T | Promise<T>): Promise<T> {
        const task = this.allocation.then(async () => {
            const used = new Set(this.roles().map(r => r.port));
            for (let p = this.managerPort + 1; p < Math.min(65536, this.managerPort + 1000); p++)
                if (!used.has(p) && await portAvailable(p, this.host))
                    return await fn(p);
            throw Error('没有可用的角色入口端口');
        });
        this.allocation = task.catch(() => { });
        return task;
    }
    forget(id: string) { this.processes.delete(id); }
    target(id: string) {
        this.role(id);
        const p = this.processes.get(id);
        if (!p || p.child.exitCode !== null || p.child.signalCode !== null)
            throw Error('角色已停止');
        return { port: p.port, cookie: p.cookie };
    }
    async request(id: string, path: string, method = 'GET', body?: unknown): Promise<Response> {
        const p = this.target(id);
        return fetch(`http://127.0.0.1:${p.port}${path}`, { method,
            headers: { cookie: p.cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
            body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) });
    }
    async refresh(): Promise<void> {
        await Promise.all([...this.processes].filter(([, p]) => ['running', 'paused'].includes(p.state) || p.restartPid !== undefined).map(async ([id, p]) => {
            try {
                if (p.restartPid !== undefined && (!this.pid(id) || this.pid(id) === p.restartPid))
                    return;
                const r = await this.request(id, '/api/status');
                if (r.ok) {
                    p.state = (await r.json()).loop.paused ? 'paused' : 'running';
                    delete p.restartPid;
                }
            }
            catch { /* Native restart briefly takes its HTTP listener down; its launcher remains the owner. */ }
        }));
    }
    pid(id: string): number | undefined {
        const r = this.role(id), cfg = json<any>(join(this.home, id, 'config.json'), {});
        return json<any>(join(this.home, id, cfg.paths?.data || profile(r.bot).dataDir, 'instance.lock'), {}).pid;
    }
    noteRestart(id: string, pid: number | undefined) { const p = this.processes.get(id); if (p && pid) {
        p.restartPid = pid;
        p.state = 'starting';
    } }
    private async readyAfterRestart(id: string) {
        const end = Date.now() + 90000;
        while (this.processes.get(id)?.restartPid !== undefined) {
            if (Date.now() >= end)
                throw Error('角色重启尚未完成');
            await this.refresh();
            await sleep(100);
        }
    }
    async start(id: string): Promise<void> {
        const role = this.role(id), old = this.processes.get(id);
        if (old && ['running', 'paused'].includes(old.state))
            return;
        this.assertStopped(id);
        const port = await localPort(), password = randomBytes(32).toString('hex');
        const log = openSync(join(this.root, 'logs', `${id}.log`), 'a', 0o600);
        const child = spawn(process.execPath, ['bin/cortico.mjs', id, '--host=127.0.0.1', `--port=${port}`], {
            cwd: source(), env: { ...environment(), CORTICO_WEB_PASSWORD: password }, stdio: ['ignore', log, log],
            detached: process.platform !== 'win32',
        });
        closeSync(log);
        const p: Entry = { child, port, password, cookie: '', state: 'starting', exit: Promise.resolve(null) };
        p.exit = new Promise(resolve => {
            child.once('error', error => { p.state = 'error'; p.error = error.message; resolve(null); });
            child.once('exit', code => { p.state = code === 0 ? 'stopped' : 'error'; if (code !== 0)
                p.error = `进程退出 (${code})，查看 logs/${id}.log`; resolve(code); });
        });
        this.processes.set(id, p);
        try {
            const end = Date.now() + 90000;
            while (Date.now() < end) {
                if (p.state === 'error' || p.state === 'stopped')
                    throw Error(p.error || '启动进程已退出');
                try {
                    const r = await fetch(`http://127.0.0.1:${port}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }), signal: AbortSignal.timeout(1500) });
                    if (r.ok) {
                        p.cookie = r.headers.get('set-cookie')?.split(';')[0] || '';
                        const status = await (await this.request(id, '/api/status')).json();
                        if (status.displayName !== role.name)
                            throw Error('启动后的角色身份不匹配');
                        p.state = status.loop.paused ? 'paused' : 'running';
                        return;
                    }
                }
                catch { /* Wait only for this newly started local listener. */ }
                await sleep(250);
            }
            throw Error(`启动超时，请查看 logs/${id}.log`);
        }
        catch (error) {
            await terminateStartup(p);
            p.error = (error as Error).message;
            p.state = 'error';
            throw error;
        }
    }
    async command(id: string, action: 'pause' | 'resume') {
        await this.readyAfterRestart(id);
        const response = await this.request(id, `/api/run/${action}`, 'POST');
        if (!response.ok)
            throw Error(`操作失败 (${response.status})`);
        this.processes.get(id)!.state = action === 'pause' ? 'paused' : 'running';
    }
    async stop(id: string) {
        await this.readyAfterRestart(id);
        const p = this.processes.get(id);
        if (!p || p.child.exitCode !== null || p.child.signalCode !== null)
            return;
        const response = await this.request(id, '/api/run/shutdown', 'POST');
        if (!response.ok)
            throw Error(`关机请求失败 (${response.status})`);
        p.state = 'stopping';
        let timer: ReturnType<typeof setTimeout>;
        try {
            const code = await Promise.race([p.exit, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('关机尚未完成，未复制或删除数据')), 105000); })]);
            if (code !== 0)
                throw Error('角色未正常关机，未复制或删除数据');
        }
        finally {
            clearTimeout(timer!);
        }
    }
    assertStopped(id: string) {
        const p = this.processes.get(id);
        if (p && p.child.pid && p.child.exitCode === null && p.child.signalCode === null)
            throw Error('角色进程尚未退出');
        const r = this.role(id), cfg = json<any>(join(this.home, id, 'config.json'), {});
        const lock = json<any>(join(this.home, id, cfg.paths?.data || profile(r.bot).dataDir, 'instance.lock'), null);
        if (lock?.pid) {
            try {
                process.kill(lock.pid, 0);
            }
            catch (e) {
                if ((e as NodeJS.ErrnoException).code === 'ESRCH')
                    return;
                throw e;
            }
            throw Error('部署仍由其他进程占用');
        }
    }
    async close() { await Promise.all([...this.processes.keys()].map(id => this.stop(id))); }
}
