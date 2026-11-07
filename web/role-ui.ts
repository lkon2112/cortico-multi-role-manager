import { t } from './i18n.ts';
/** Shared role presentation within the independent manager. */
import { icon } from './icons.ts';
import type { Role } from '../src/types.ts';
export const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
export const states: Record<string, string> = { running: t("运行中"), paused: t("已暂停"), stopped: t("已停止"), starting: t("启动中"), stopping: t("停止中"), error: t("异常") };
export const alive = (r: Role) => r.state === 'running' || r.state === 'paused';
export const pendingStarts = new Set<string>();
function startPresentation(r: Role, label: string, iconOnly: boolean) {
    const busy = pendingStarts.has(r.id) || r.state === 'starting';
    return { busy, disabled: busy || r.state === 'stopping', label: busy ? t('启动中') : label,
        content: busy ? `<span class="spinner" aria-hidden="true"></span>${iconOnly ? '' : esc(t('启动中'))}` : iconOnly ? icon('play') : esc(label) };
}
export function startButton(r: Role, label = t('启动'), className = 'btn primary', iconOnly = false) {
    const s = startPresentation(r, label, iconOnly);
    return `<button class="${className}" data-action="start" data-id="${esc(r.id)}" data-start-label="${esc(label)}" data-start-icon="${iconOnly}" aria-busy="${s.busy}" aria-label="${esc(s.label)}" title="${esc(s.label)}" ${s.disabled ? 'disabled' : ''}>${s.content}</button>`;
}
export function syncStartButtons(root: ParentNode, roles: Role[]) {
    root.querySelectorAll<HTMLButtonElement>('[data-action="start"]').forEach(b => {
        const r = roles.find(r => r.id === b.dataset.id);
        if (!r) return;
        const s = startPresentation(r, b.dataset.startLabel!, b.dataset.startIcon === 'true');
        b.disabled = s.disabled;
        b.innerHTML = s.content;
        b.title = s.label;
        b.setAttribute('aria-label', s.label);
        b.setAttribute('aria-busy', String(s.busy));
    });
}
export function avatar(r: Role, src: string) { return `<span class="rail-avatar-wrap"><span class="rail-avatar">${r.avatar ? `<img class="rail-avatar-image" src="${esc(src)}" alt="">` : `<span class="rail-avatar-fallback">${esc(r.name.slice(0, 1))}</span>`}</span></span>`; }
export function button(action: string, label: string, mark: string, id: string, disabled = false) { return `<button class="rail-action" data-action="${action}" data-id="${esc(id)}" aria-label="${label}" title="${label}" ${disabled ? 'disabled' : ''}>${icon(mark)}</button>`; }
export function actions(r: Role) { return `<div class="rail-actions">${alive(r) ? button(r.state === 'running' ? 'pause' : 'resume', r.state === 'running' ? t("暂停") : t("继续"), r.state === 'running' ? 'pause' : 'play', r.id) : startButton(r, t('启动'), 'rail-action', true)}${button('settings', t("设置"), 'settings', r.id, !alive(r))}${button('stop', t("关机"), 'power', r.id, !alive(r))}</div>`; }
let noticeTimer: ReturnType<typeof setTimeout>;
export function notice(text: string) {
    clearTimeout(noticeTimer);
    document.querySelector('#manager-notice')?.remove();
    const el = document.createElement('div');
    el.id = 'manager-notice';
    el.setAttribute('role', 'status');
    el.textContent = t(text);
    document.body.append(el);
    requestAnimationFrame(() => el.classList.add('show'));
    noticeTimer = setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 150); }, 4000);
}
