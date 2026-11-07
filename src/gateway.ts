/** Transparent per-role origins keep native paths and localStorage isolated, with one manager login. */
import http from 'node:http';
import net, { type Socket } from 'node:net';
import type { Auth } from './auth.ts';
import type { Supervisor } from './supervisor.ts';
/** A browser entry, separate from the unmodified native page served inside the manager. */
export function roleEntry(roleId: string, managerPort: number): string {
    return `<!doctype html><meta charset="utf-8"><title>Cortico Multi-Role Manager</title><script>
const destination = new URL(location.href);
destination.port = ${managerPort};
destination.pathname = '/';
destination.search = '';
destination.hash = ${JSON.stringify('role/' + encodeURIComponent(roleId))} + '?page=' + encodeURIComponent(location.hash || '#/live');
location.replace(destination.href);
</script>`;
}
export class Gateways {
    private servers = new Map<string, {
        server: http.Server;
        port: number;
    }>();
    private sockets = new Set<Socket>();
    private syncing: Promise<void> = Promise.resolve();
    private unwatch: () => void;
    constructor(private auth: Auth, private supervisor: Supervisor) {
        this.unwatch = auth.onChange(() => { for (const socket of this.sockets)
            socket.destroy(); });
    }
    private headers(req: http.IncomingMessage, port: number, cookie: string) {
        const headers: http.IncomingHttpHeaders = { ...req.headers, host: `127.0.0.1:${port}`, cookie };
        if (headers.origin)
            headers.origin = `http://127.0.0.1:${port}`;
        delete headers['x-forwarded-host'];
        return headers;
    }
    private accepted(req: http.IncomingMessage) { return !req.headers.origin || req.headers.origin === `http://${req.headers.host}`; }
    sync() {
        const task = this.syncing.then(() => this.syncRoles());
        this.syncing = task.catch(() => { });
        return task;
    }
    private async syncRoles() {
        const roles = this.supervisor.roles();
        for (const [id, entry] of this.servers)
            if (!roles.some(r => r.id === id && r.port === entry.port)) {
                entry.server.closeAllConnections();
                entry.server.close();
                this.servers.delete(id);
            }
        for (const role of roles) {
            if (this.servers.has(role.id))
                continue;
            const server = http.createServer((req, res) => {
                if (!this.accepted(req)) {
                    res.writeHead(403).end();
                    return;
                }
                const url = new URL(req.url || '/', 'http://localhost');
                if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
                    if (url.searchParams.get('__cortico_frame') !== '1') {
                        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
                            .end(roleEntry(role.id, this.supervisor.managerPort));
                        return;
                    }
                    url.searchParams.delete('__cortico_frame');
                    req.url = url.pathname + url.search;
                }
                if (!this.auth.logged(req)) {
                    res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }).end('请先登录管理中心');
                    return;
                }
                if (req.url === '/api/auth/status') {
                    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({ required: true, authenticated: true }));
                    return;
                }
                if (req.url === '/api/auth/logout' && req.method === 'POST') {
                    this.auth.logout();
                    for (const s of this.sockets)
                        s.destroy();
                    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
                    return;
                }
                let target;
                try {
                    target = this.supervisor.target(role.id);
                }
                catch {
                    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' }).end('角色已停止，请在管理中心启动');
                    return;
                }
                const restartPid = req.url === '/api/run/restart' && req.method === 'POST' ? this.supervisor.pid(role.id) : undefined;
                const up = http.request({ host: '127.0.0.1', port: target.port, path: req.url, method: req.method, headers: this.headers(req, target.port, target.cookie) }, response => {
                    if (restartPid && response.statusCode === 200)
                        this.supervisor.noteRestart(role.id, restartPid);
                    const headers = { ...response.headers };
                    delete headers['set-cookie'];
                    if (typeof headers['content-security-policy'] === 'string') {
                        const host = (req.headers.host || '').replace(/:\d+$/, '');
                        headers['content-security-policy'] = headers['content-security-policy'].replace(/frame-ancestors[^;]*/, `frame-ancestors 'self' http://${host}:${this.supervisor.managerPort}`);
                    }
                    res.writeHead(response.statusCode || 502, headers);
                    response.pipe(res);
                });
                up.on('error', () => { if (!res.headersSent)
                    res.writeHead(502); res.end(); });
                res.on('close', () => up.destroy());
                req.pipe(up);
            });
            server.on('upgrade', (req, socket, head) => {
                if (!this.accepted(req) || !this.auth.logged(req)) {
                    socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
                    return;
                }
                let target;
                try {
                    target = this.supervisor.target(role.id);
                }
                catch {
                    socket.destroy();
                    return;
                }
                const up = net.connect(target.port, '127.0.0.1', () => {
                    const headers = this.headers(req, target.port, target.cookie);
                    up.write(`${req.method} ${req.url} HTTP/1.1\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`);
                    if (head.length)
                        up.write(head);
                    socket.pipe(up).pipe(socket);
                });
                this.sockets.add(socket as Socket);
                socket.on('close', () => { this.sockets.delete(socket as Socket); up.destroy(); });
                socket.on('error', () => up.destroy());
                up.on('error', () => socket.destroy());
            });
            await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(role.port, this.supervisor.host, resolve); });
            this.servers.set(role.id, { server, port: role.port });
        }
    }
    async close() {
        this.unwatch();
        for (const socket of this.sockets)
            socket.destroy();
        await Promise.all([...this.servers.values()].map(({ server }) => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); })));
        this.servers.clear();
    }
}
