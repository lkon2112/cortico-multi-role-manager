import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { json, validId, writeJson } from './io.ts';
import type { CloneReview } from './types.ts';

/** A local configuration checklist, not a probe of accounts or external services. */
export function cloneReview(home: string, id: string): CloneReview {
    if (!validId(id)) throw Error('角色标识无效');
    const dir = join(home, id), metadata = json<any>(join(dir, '.manager.json'));
    if (!metadata.clone) throw Error('这个角色没有复制记录');
    const config = json<any>(join(dir, 'config.json')), notes: string[] = [];
    if (metadata.clone.runtime) notes.push('检查继承的定时任务与待处理消息，避免重复执行。');
    if (existsSync(join(dir, '.env'))) notes.push('.env 已保留，请检查共享的服务凭据。');
    const worlds = Object.entries(config.worlds ?? {}).filter(([id]) => id !== 'console').map(([id, raw]) => {
        const world = raw as Record<string, unknown>, hints = new Set<string>(), fields: string[] = [];
        if (id === 'qq') hints.add('共享 QQ 连接可能重复收消息和回复。');
        if (id === 'minecraft' || /dungeon|game/i.test(id)) hints.add('游戏账号与进度可能仍由来源和副本共享。');
        function scan(value: unknown, path = '') {
            if (!value || typeof value !== 'object') return;
            for (const [key, item] of Object.entries(value)) {
                const field = path ? `${path}.${key}` : key;
                if (item && typeof item === 'object') { scan(item, field); continue; }
                if (item === null || item === undefined || item === '') continue;
                if (/port$/i.test(key)) { hints.add('检查端口用途；本地监听端口可能与来源冲突。'); fields.push(field); }
                else if (/account|user(name|id)?$|token|secret|api.?key|cookie|sessdata/i.test(key)) { hints.add('账号或凭据沿用来源，请按需要更换。'); fields.push(field); }
                else if (typeof item === 'string' && (isAbsolute(item) || item.startsWith('../') || /^(https?|wss?|postgres(ql)?|mysql|mongodb|redis):/i.test(item))) {
                    hints.add('外部地址或目录仍指向原位置，数据未打包。'); fields.push(field);
                }
            }
        }
        scan(world);
        if (!hints.size) hints.add('请检查此 World 的共享资源与外部账号设置。');
        return { id, enabled: world.enabled !== false, hints: [...hints], fields };
    });
    return { mode: metadata.clone.mode, worlds, notes, externalLinks: metadata.clone.externalLinks ?? [] };
}

/** The caller holds the role lock and checks that the clone is stopped. */
export function setCloneWorldEnabled(home: string, id: string, world: string, enabled: boolean): void {
    if (typeof enabled !== 'boolean') throw Error('World 开关值无效');
    const review = cloneReview(home, id);
    if (!review.worlds.some(w => w.id === world)) throw Error('找不到 World');
    const file = join(home, id, 'config.json'), config = json<any>(file);
    config.worlds[world].enabled = enabled;
    writeJson(file, config);
}
