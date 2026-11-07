/** The only Cortico installation boundary: its CLI, deployment files and public HTTP API. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { json } from './io.ts';
import type { Profile } from './types.ts';
export { json, validId } from './io.ts';
const exec = promisify(execFile);
export interface Installation {
    source: string;
    root: string;
    env?: NodeJS.ProcessEnv;
}
let installation: Installation;
export function configure(value: Installation) {
    installation = { ...value, source: resolve(value.source), root: resolve(value.root) };
    if (!existsSync(join(installation.source, 'bin/cortico.mjs')))
        throw Error('请选择官方 Cortico 安装目录');
    mkdirSync(join(installation.root, 'deployments'), { recursive: true });
}
export function environment(): NodeJS.ProcessEnv {
    return { ...process.env, ...installation.env, CORTICO_HOME: join(installation.root, 'deployments'),
        CORTICO_EXTENSIONS_DIR: join(installation.root, 'extensions'), CORTICO_START_PAUSED: '1', CORTICO_OPEN_BROWSER: '0' };
}
export function source() { return installation.source; }
async function cli(args: string[], root?: string) {
    const { stdout } = await exec(process.execPath, ['--import', 'tsx', 'src/launcher.ts', ...args], {
        cwd: source(), env: { ...environment(), ...(root ? { CORTICO_HOME: root } : {}) }, timeout: 60000,
    });
    return stdout;
}
export async function templates(): Promise<{
    id: string;
    label: string;
}[]> {
    const result = JSON.parse(await cli(['--json']));
    return result.packages.map((p: {
        id: string;
        displayName?: string;
    }) => ({ id: p.id, label: `${p.id} · ${p.displayName || p.id}` }));
}
export async function createDeployment(options: {
    name: string;
    bot: string;
    displayName: string;
    root: string;
}) {
    await cli([`--create-deployment=${options.name}`, `--bot=${options.bot}`, `--display-name=${options.displayName}`], options.root);
}
const connections: Profile['connections'] = {
    qq: { label: 'QQ / NapCat', keys: ['wsUrl', 'token', 'groups', 'privates'], secrets: ['OPENROUTER_API_KEY'] },
    minecraft: { label: 'Minecraft', keys: ['host', 'port', 'username', 'local', 'viewerPort'], secrets: [] },
    bilibili: { label: 'Bilibili', keys: ['roomId', 'sessdata'], secrets: [] },
    websearch: { label: 'WebSearch', keys: [], secrets: ['BRAVE_API_KEY', 'DEEPSEEK_SEARCH_API_KEY'] },
};
/** Copy rules are owned here, never added to official Bot/World definitions. */
export function profile(id: string, dir?: string): Profile {
    const custom = json<Record<string, Partial<Profile>>>(join(installation.root, 'copy-rules.json'), {})[id];
    const builtin = ['cormini', 'cortiv', 'corti-soulmate'].includes(id);
    const p: Profile = { id, label: id, memoryDir: id === 'corti-soulmate' ? 'memory' : 'workspace', dataDir: 'data',
        settingsInMemory: ['CONSTITUTION.md'], copyDeclared: builtin || !!custom, worldState: ['bilibili-audience', 'bilibili-overlay'],
        ...custom, connections: { ...connections, ...custom?.connections } };
    for (const path of [p.memoryDir, p.dataDir, ...p.settingsInMemory, ...p.worldState]) {
        if (typeof path !== 'string' || !path || isAbsolute(path) || path.split(/[\\/]/).some(s => s === '..' || s === '.'))
            throw Error('复制规则包含无效路径');
    }
    if (dir) {
        const cfg = json<any>(join(dir, 'config.json'), {});
        for (const [world, value] of Object.entries(cfg.worlds ?? {})) {
            if (world === 'console' || p.connections[world])
                continue;
            // Unknown World configuration may carry external identities: explicit opt-in copies it whole.
            p.connections[world] = { label: world, keys: Object.keys(value as object), secrets: [] };
        }
    }
    return p;
}
