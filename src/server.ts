import express from 'express';
import http from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { managementAuth, sameOrigin } from './auth.ts';
import { Supervisor } from './supervisor.ts';
import { Gateways } from './gateway.ts';
import { Jobs } from './jobs.ts';
import { Operations } from './operations.ts';
import { inspectClone } from './clone.ts';
import { cloneReview, setCloneWorldEnabled } from './clone-review.ts';
import { configure, templates, type Installation } from './adapter.ts';
import { json, writeJson } from './io.ts';
import type { Action } from './types.ts';
const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
const route = (fn: (q: express.Request, s: express.Response) => unknown): express.RequestHandler => (q, s, next) => { Promise.resolve().then(() => fn(q, s)).catch(next); };
export async function createManager(options: Installation & {
    port: number;
    host: string;
}) {
    configure(options);
    const { root, port, host } = options, auth = managementAuth(root), supervisor = new Supervisor(root, port, host);
    const jobs = new Jobs(join(root, 'jobs'), supervisor), operations = new Operations(root, supervisor), gateways = new Gateways(auth, supervisor);
    let limit = json(join(root, 'history-settings.json'), { limit: 200 }).limit;
    jobs.setLimit(limit);
    operations.setLimit(limit);
    const app = express();
    app.disable('x-powered-by');
    app.use(sameOrigin);
    app.use(express.json({ limit: '1mb' }));
    app.get('/api/auth/status', (q, s) => s.json({ required: true, authenticated: auth.logged(q), setupRequired: !auth.configured }));
    app.post('/api/auth/setup', route((q, s) => auth.setup(q, s)));
    app.post('/api/auth/login', route((q, s) => auth.loginRequest(q, s)));
    app.post('/api/auth/logout', route((q, s) => auth.logoutRequest(q, s)));
    app.use('/api', auth.guard);
    app.post('/api/auth/password', route((q, s) => auth.change(q, s)));
    app.get('/api/current', (_q, s) => s.json({ kind: 'manager', managerPort: port, runtime: 'cortico' }));
    // Polling only reads local state. No model or quota calls.
    let refresh: Promise<void> | undefined;
    app.get('/api/roles', route(async (_q, s) => {
        refresh ??= supervisor.refresh().then(() => gateways.sync()).finally(() => { refresh = undefined; });
        await refresh;
        s.json(supervisor.roles());
    }));
    app.get('/api/templates', route(async (_q, s) => s.json(await templates())));
    app.get('/api/theme', (_q, s) => s.json(json(join(root, 'theme.json'), { scheme: 'crab-daisy', mode: 'system' })));
    app.post('/api/theme', route((q, s) => { const { scheme, mode } = q.body; if (typeof scheme !== 'string' || !['light', 'dark', 'system'].includes(mode))
        throw Error('无效主题'); writeJson(join(root, 'theme.json'), { scheme, mode }); s.json({ ok: true }); }));
    app.get('/api/jobs', (_q, s) => s.json(jobs.list()));
    app.post('/api/jobs', route(async (q, s) => {
        if (!(await templates()).some(t => t.id === q.body.bot))
            throw Error('找不到 Bot 模板');
        s.status(202).json(jobs.create(q.body));
    }));
    app.get('/api/roles/:id/clone-info', route((q, s) => s.json(inspectClone(supervisor.home, q.params.id))));
    app.get('/api/roles/:id/clone-review', route((q, s) => { supervisor.role(q.params.id); s.json(cloneReview(supervisor.home, q.params.id)); }));
    app.post('/api/roles/:id/world-enabled', route(async (q, s) => {
        await supervisor.exclusive(q.params.id, async () => {
            supervisor.role(q.params.id);
            supervisor.assertStopped(q.params.id);
            setCloneWorldEnabled(supervisor.home, q.params.id, q.body.world, q.body.enabled);
        });
        s.json(cloneReview(supervisor.home, q.params.id));
    }));
    app.get('/api/roles/:id/avatar', route((q, s) => { const r = supervisor.role(q.params.id); if (!r.avatar) {
        s.sendStatus(404);
        return;
    } s.sendFile(join(supervisor.home, r.id, 'avatar.png')); }));
    app.post('/api/roles/:id/delete', route(async (q, s) => { await operations.archive(q.params.id); await gateways.sync(); s.json({ ok: true }); }));
    app.post('/api/roles/:id/:action', route(async (q, s) => { s.json(await operations.action(q.params.id, q.params.action as Action)); }));
    app.get('/api/operations', (_q, s) => s.json(operations.records()));
    app.get('/api/schedules', (_q, s) => s.json(operations.schedules()));
    app.post('/api/schedules', route((q, s) => s.json(operations.setSchedule(q.body))));
    app.post('/api/schedules/:id/:action', route((q, s) => { operations.changeSchedule(q.params.id, q.params.action as 'enable' | 'disable' | 'remove'); s.json({ ok: true }); }));
    app.get('/api/trash', (_q, s) => s.json(operations.deleted()));
    app.post('/api/trash/purge', route((q, s) => { operations.purge(q.body.keys); s.json({ ok: true }); }));
    app.post('/api/trash/:key/restore', route(async (q, s) => { const r = await operations.restore(q.params.key); await gateways.sync(); s.json(r); }));
    app.get('/api/history/settings', (_q, s) => s.json({ limit }));
    app.post('/api/history/settings', route((q, s) => { const n = q.body.limit; if (!Number.isInteger(n) || n < 10 || n > 10000)
        throw Error('保留条数须为 10–10000 的整数'); writeJson(join(root, 'history-settings.json'), { limit: n }); limit = n; jobs.setLimit(n); operations.setLimit(n); s.json({ limit }); }));
    app.post('/api/history/clear', (_q, s) => { jobs.clear(); operations.clear(); s.json({ ok: true }); });
    app.use(express.static(publicDir, { index: 'index.html' }));
    app.use(((e, _q, s, _n) => { s.status(400).json({ error: e instanceof Error ? e.message : String(e) }); }) as express.ErrorRequestHandler);
    const server = http.createServer(app);
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
    try {
        await gateways.sync();
    }
    catch (e) {
        server.close();
        await gateways.close();
        throw e;
    }
    operations.start();
    return { server, supervisor, jobs, operations, gateways, auth, async close() { await operations.close(); await jobs.wait(); await supervisor.close(); await gateways.close(); await new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }); } };
}
