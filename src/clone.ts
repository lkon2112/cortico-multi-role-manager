import { cpSync, existsSync, lstatSync, readlinkSync, realpathSync, symlinkSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, isAbsolute, resolve, relative, dirname, sep } from 'node:path';
type CoreStateData = Record<string, unknown>;
import { createDeployment } from './adapter.ts';
import { json, profile, validId } from './adapter.ts';
import { EMPTY_COPY, type CopyOptions, type CreateInput, type Profile } from './types.ts';
import { writeJson } from './io.ts';
export function normalizeCopy(raw: Partial<CopyOptions>): CopyOptions {
    const value = { ...EMPTY_COPY, ...raw };
    for (const key of ['memory', 'session', 'history', 'timers', 'pending', 'worldState'] as const)
        value[key] = raw[key] === true;
    value.connections = Array.isArray(raw.connections) ? [...new Set(raw.connections.filter((v): v is string => typeof v === 'string'))] : [];
    // Pending delivery resumes against the source conversation and persona state.
    if (value.pending) {
        value.history = true;
        value.session = true;
        value.memory = true;
        value.worldState = true;
    }
    if (value.timers)
        value.memory = true;
    return value;
}
function copy(from: string, to: string): void {
    if (!existsSync(from))
        return;
    cpSync(from, to, { recursive: true, filter: (p) => {
            if (lstatSync(p).isSymbolicLink())
                throw new Error(`复制范围中有符号链接，请单独处理：${p}`);
            return true;
        } });
}
function checkPaths(dir: string, p: Profile): void {
    const config = json<any>(join(dir, 'config.json'), {});
    for (const [key, expected] of [['memory', p.memoryDir], ['data', p.dataDir]]) {
        const v = config.paths?.[key];
        if (v && (isAbsolute(v) || v !== expected))
            throw new Error(`自定义 paths.${key} 尚未适配，请先核对数据目录。`);
    }
}
function inside(root: string, path: string): boolean {
    const rel = relative(root, path);
    return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
/** Full snapshots accept custom local paths, but never share the source Core's storage. */
function localPaths(dir: string, p: Profile): { memory: string; data: string } {
    const config = json<any>(join(dir, 'config.json'), {});
    return Object.fromEntries(Object.entries({ memory: p.memoryDir, data: p.dataDir }).map(([key, fallback]) => {
        const path = resolve(dir, config.paths?.[key] || fallback);
        let parent = path;
        while (!lstatSync(parent, { throwIfNoEntry: false })) parent = dirname(parent);
        const actual = realpathSync(parent), root = realpathSync(dir);
        if (!inside(dir, path) || (actual !== root && !inside(root, actual)))
            throw Error(`paths.${key} 位于部署目录之外，请先迁入部署目录再克隆。`);
        return [key, relative(dir, path)];
    })) as { memory: string; data: string };
}
export function inspectClone(home: string, id: string) {
    if (!validId(id)) throw Error('角色标识无效');
    const dir = join(home, id), p = profile(json(join(dir, 'deployment.json')).bot, dir);
    const config = json<any>(join(dir, 'config.json'), {});
    let selectiveError = '', fullError = '';
    try {
        if (!p.copyDeclared) throw Error('这个 Bot 尚未适配复制，请在管理器 copy-rules.json 中添加规则。');
        checkPaths(dir, p);
    } catch (e) { selectiveError = (e as Error).message; }
    try { localPaths(dir, p); } catch (e) { fullError = (e as Error).message; }
    const known = new Set(['core-state.json', 'timers.json', 'session-main.jsonl', 'runs', 'usage.jsonl', 'media', 'instance.lock', 'web-auth.key', '.restart-request', 'service.stdout.log', 'service.stderr.log', ...p.worldState.map(path => path.replaceAll('\\', '/').split('/')[0])]);
    const extraData = !selectiveError && existsSync(join(dir, p.dataDir)) ? readdirSync(join(dir, p.dataDir)).filter(f => !known.has(f) && !f.endsWith('.tmp')) : [];
    return { bot: p.id, connections: Object.entries(p.connections).filter(([id]) => config.worlds?.[id]).map(([id, c]) => ({ id, label: c.label })), extraData, selectiveError, fullError };
}
export function validateCreate(home: string, input: CreateInput): void {
    if (!validId(input.id))
        throw new Error('目录名使用小写字母开头，包含字母、数字或短横线，最长 48 字符。');
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 80)
        throw new Error('请填写 1–80 字的角色名称。');
    if (existsSync(join(home, input.id)))
        throw new Error('这个目录名已经存在。');
    profile(input.bot);
    if (input.copyMode && !['selective', 'full'].includes(input.copyMode)) throw Error('复制方式无效');
    if (input.source) {
        const info = inspectClone(home, input.source);
        const error = input.copyMode === 'full' ? info.fullError : info.selectiveError;
        if (error) throw Error(error);
        if (input.copyMode !== 'full' && input.copy.worldState && info.extraData.length)
            throw Error(`请先在 copy-rules.json 中分类这些 World 本地状态：${info.extraData.join('、')}`);
        if (info.bot !== input.bot)
            throw new Error('复制时需要使用来源角色的 Bot 模板。');
        for (const id of input.copy.connections)
            if (!info.connections.some(c => c.id === id))
                throw new Error('连接选项无效');
    }
}
function eventsSnapshot(src: string, dst: string, fullHistory: boolean): number {
    let high = 0;
    const runs = join(src, 'runs');
    if (!existsSync(runs))
        return high;
    if (fullHistory)
        copy(runs, join(dst, 'runs'));
    for (const run of readdirSync(runs, { withFileTypes: true }).filter(e => e.isDirectory())) {
        const f = join(runs, run.name, 'events.jsonl');
        if (!existsSync(f))
            continue;
        for (const line of readFileSync(f, 'utf8').split('\n').filter(Boolean)) {
            const event = JSON.parse(line);
            if (!Number.isInteger(event.cursor))
                throw new Error('事件记录缺少有效 cursor');
            high = Math.max(high, event.cursor);
        }
        if (!fullHistory) {
            copy(f, join(dst, 'runs', run.name, 'events.jsonl'));
            copy(join(runs, run.name, 'run.json'), join(dst, 'runs', run.name, 'run.json'));
        }
    }
    return high;
}
/** Stop the source when copying runtime data. Writes use an unpublished staging directory. */
export async function createSnapshot(home: string, input: CreateInput, port: number): Promise<string> {
    input = { ...input, copy: normalizeCopy(input.copy) };
    validateCreate(home, input);
    const p = profile(input.bot, input.source ? join(home, input.source) : undefined), target = join(home, input.id), stage = join(home, `.creating-${input.id}`);
    if (existsSync(stage))
        throw new Error('同名创建任务尚未结束');
    if (!input.source) {
        await createDeployment({ name: input.id, bot: input.bot, displayName: input.name.trim(), root: home });
        writeJson(join(target, '.manager.json'), { port });
        return target;
    }
    mkdirSync(stage);
    try {
        const src = join(home, input.source);
        if (input.copyMode === 'full') {
            const paths = localPaths(src, p), externalLinks: string[] = [];
            // Keep links as links. Internal targets follow the clone; external data stays external.
            cpSync(src, stage, { recursive: true, verbatimSymlinks: true });
            function relocateLinks(dir: string) {
                for (const entry of readdirSync(dir, { withFileTypes: true })) {
                    const file = join(dir, entry.name), rel = relative(stage, file);
                    if (entry.isSymbolicLink()) {
                        const target = resolve(dirname(join(src, rel)), readlinkSync(file));
                        const canonical = existsSync(target) ? realpathSync(target) : target;
                        const root = realpathSync(src);
                        const localPath = target === src || inside(src, target) ? relative(src, target)
                            : canonical === root || inside(root, canonical) ? relative(root, canonical) : null;
                        const local = localPath !== null;
                        if (!local) externalLinks.push(rel);
                        if (!local && ['config.json', 'deployment.json', '.manager.json'].includes(rel))
                            throw Error('部署配置是外部符号链接，请改成本地文件后克隆。');
                        rmSync(file);
                        symlinkSync(local ? relative(dirname(file), join(stage, localPath)) || '.' : target, file);
                    } else if (entry.isDirectory()) relocateLinks(file);
                }
            }
            relocateLinks(stage);
            const config: any = json(join(stage, 'config.json'), {});
            config.displayName = input.name.trim();
            config.web = { ...config.web, host: '127.0.0.1', port };
            delete config.web.password;
            config.paths = { ...config.paths, ...paths };
            for (const file of ['instance.lock', 'web-auth.key', '.restart-request', 'service.stdout.log', 'service.stderr.log'])
                rmSync(join(stage, paths.data, file), { force: true });
            writeJson(join(stage, 'config.json'), config);
            writeJson(join(stage, '.manager.json'), { port, clone: { mode: 'full', source: input.source, externalLinks, runtime: true } });
            renameSync(stage, target);
            return target;
        }
        const config: any = json(join(src, 'config.json'), {});
        config.displayName = input.name.trim();
        config.web = { ...config.web, host: '127.0.0.1', port };
        delete config.web.password; // Managed deployments share the manager's access policy.
        config.paths = { ...config.paths, memory: p.memoryDir, data: p.dataDir };
        mkdirSync(join(stage, p.memoryDir), { recursive: true });
        mkdirSync(join(stage, p.dataDir), { recursive: true });
        for (const name of ['prompts', 'avatar.png', 'theme.json'])
            copy(join(src, name), join(stage, name));
        const worldPrompts = join(src, 'worlds');
        if (existsSync(worldPrompts))
            for (const world of readdirSync(worldPrompts, { withFileTypes: true })) {
                if (world.isDirectory())
                    copy(join(worldPrompts, world.name, 'ENV_PROMPT.md'), join(stage, 'worlds', world.name, 'ENV_PROMPT.md'));
            }
        if (input.copy.memory)
            copy(join(src, p.memoryDir), join(stage, p.memoryDir));
        else
            for (const name of p.settingsInMemory)
                copy(join(src, p.memoryDir, name), join(stage, p.memoryDir, name));
        const sd = join(src, p.dataDir), dd = join(stage, p.dataDir), o = input.copy;
        const state = json<any>(join(sd, 'core-state.json'), {});
        const high = (o.history || o.session) ? eventsSnapshot(sd, dd, o.history) : 0;
        if (o.session)
            copy(join(sd, 'session-main.jsonl'), join(dd, 'session-main.jsonl'));
        if (o.session || o.memory || o.history || o.worldState)
            copy(join(sd, 'media'), join(dd, 'media'));
        if (o.history)
            copy(join(sd, 'usage.jsonl'), join(dd, 'usage.jsonl'));
        if (o.timers)
            copy(join(sd, 'timers.json'), join(dd, 'timers.json'));
        if (o.worldState)
            for (const name of p.worldState)
                copy(join(sd, name), join(dd, name));
        writeJson(join(dd, 'core-state.json'), {
            lastTruncateAt: o.session ? (state.lastTruncateAt ?? null) : null,
            lastDeliveredCursor: o.pending ? (state.lastDeliveredCursor ?? 0) : high,
            llmStall: { since: 0, at: [] }, persona: o.memory ? (state.persona ?? {}) : {}, worldVisibility: state.worldVisibility ?? {}
        } satisfies CoreStateData);
        const secrets = new Set<string>();
        for (const [id, connection] of Object.entries(p.connections)) {
            if (o.connections.includes(id)) {
                connection.secrets.forEach(k => secrets.add(k));
                continue;
            }
            {
                config.worlds ??= {};
                config.worlds[id] ??= {};
                config.worlds[id].enabled = false;
                for (const key of connection.keys)
                    delete config.worlds[id][key];
            }
        }
        const env = existsSync(join(src, '.env')) ? readFileSync(join(src, '.env'), 'utf8') : '';
        const selected = env.split('\n').filter(line => {
            const key = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/)?.[1];
            return !!key && secrets.has(key);
        });
        if (selected.length)
            writeFileSync(join(stage, '.env'), selected.join('\n') + '\n', { mode: 0o600 });
        writeJson(join(stage, 'deployment.json'), { bot: input.bot });
        writeJson(join(stage, 'config.json'), config);
        writeJson(join(stage, '.manager.json'), { port, clone: { mode: 'selective', source: input.source, externalLinks: [], runtime: input.copy.timers || input.copy.pending } });
        renameSync(stage, target);
        return target;
    }
    catch (error) {
        rmSync(stage, { recursive: true, force: true });
        throw error;
    }
}
