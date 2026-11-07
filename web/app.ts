import { creation } from './creation.ts';
import { historyPages } from './history.ts';
import { bind, invalidatePage, pageGuard } from './page.ts';
import { t } from './i18n.ts';
import { management } from './management.ts';
import { esc, states, alive, avatar as sharedAvatar, actions, notice, startButton, pendingStarts, syncStartButtons } from './role-ui.ts';
import { icon, wordmark } from './icons.ts';
import { type Role, type Job } from '../src/types.ts';
import { BUILTIN_PALETTES } from './vendor/theme.ts';
import { initTheme, appearanceSettings, languageSettings } from './settings.ts';
for (const [key, value] of Object.entries(BUILTIN_PALETTES['crab-daisy'].light))
    document.documentElement.style.setProperty(`--${key}`, value);
document.title = `Cortico · ${t('管理中心')}`;
const app = document.querySelector<HTMLDivElement>('#app')!;
let current: any, roles: Role[] = [], poll: ReturnType<typeof setInterval> | undefined;
function manager(path = '') { return `/api${path}`; }
function managerURL(hash = '') { return '/' + hash; }
function nativeURL(r: Role, hash = '#/live') { return `${location.protocol}//${location.hostname}:${r.port}/?__cortico_frame=1${hash}`; }
function roleURL(r: Role, hash = '') { return `#role/${r.id}${hash ? '?page=' + encodeURIComponent(hash) : ''}`; }
async function api<T = any>(url: string, body?: unknown): Promise<T> {
    const response = await fetch(url, { method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const value = await response.json();
    if (response.status === 401 && current) {
        clearInterval(poll);
        current = undefined;
        login();
    }
    if (!response.ok)
        throw new Error(value.error || t("请求失败"));
    return value;
}
const toast = notice;
function avatarSource(r: Role) { return manager('/roles/' + r.id + '/avatar') + '?v=' + (r.avatarVersion ?? 0); }
function avatar(r: Role) { return sharedAvatar(r, avatarSource(r)); }
async function confirmBox(title: string, body: string): Promise<boolean> {
    const d = document.createElement('dialog');
    d.className = 'dialog modalcard';
    d.innerHTML = `<h2>${esc(title)}</h2>
<p>${esc(body)}</p>
<div class="dialog-actions"><button class="btn" value="cancel">${t("取消")}</button><button class="btn primary" value="yes">${t("确定")}</button>
</div>`;
    document.body.append(d);
    d.showModal();
    return new Promise(resolve => {
        let done = false;
        const end = (ok: boolean) => {
            if (done)
                return;
            done = true;
            d.close();
            d.remove();
            resolve(ok);
        };
        d.addEventListener('cancel', () => end(false));
        bind(d, 'button', 'click', e => end((e.currentTarget as HTMLButtonElement).value === 'yes'));
    });
}
async function perform(action: string, id: string) {
    const r = roles.find(r => r.id === id);
    if (!r)
        return;
    if (action === 'open') {
        location.hash = roleURL(r);
        return;
    }
    if (action === 'settings') {
        location.href = roleURL(r, '#/settings');
        return;
    }
    if (action === 'stop' && !await confirmBox(t("关闭{0}？", r.name), t("角色将正常保存并停止，之后可从管理入口重新启动。")))
        return;
    if (action === 'stop' && id === selectedRole()) {
        location.href = managerURL(`#stop/${id}`);
        return;
    }
    if (action === 'start') {
        if (pendingStarts.has(id) || r.state === 'starting' || r.state === 'stopping') return;
        pendingStarts.add(id);
        syncStartButtons(document, roles);
    }
    try {
        await api(manager(`/roles/${id}/${action}`), {});
        toast(action === 'start' ? t("已启动，当前处于暂停状态") : action === 'stop' ? t("角色已关闭") : action === 'resume' ? t("已继续") : t("已暂停"));
    }
    catch (e) {
        toast((e as Error).message);
    }
    finally {
        if (action === 'start') pendingStarts.delete(id);
        try { await refreshRoles(true); }
        catch (e) { toast((e as Error).message); }
        syncStartButtons(document, roles);
    }
}
function wireActions(root: ParentNode) {
    bind(root, '[data-action]', 'click', e => {
        const b = e.currentTarget as HTMLButtonElement;
        b.disabled = true;
        void perform(b.dataset.action!, b.dataset.id!).finally(() => {
            if (b.isConnected && b.dataset.action !== 'start')
                b.disabled = false;
        });
    });
}
function selectedRole() { return location.hash.startsWith('#role/') ? location.hash.slice(6).split('?')[0] : undefined; }
function roleRail() {
    const box = document.querySelector('#role-tabs');
    if (!box)
        return;
    box.innerHTML = roles.map(r => `<a class="switch-button" href="${roleURL(r)}" title="${esc(r.name)} · ${states[r.state]}" aria-label="${esc(r.name)}" aria-current="${selectedRole() === r.id ? 'page' : 'false'}">${avatar(r)}<i class="status-dot ${r.state}"></i></a>`).join('');
    document.querySelector('#manager-tab')?.setAttribute('aria-current', selectedRole() || location.hash.startsWith('#new') ? 'false' : 'page');
    document.querySelector('#create-tab')?.setAttribute('aria-current', location.hash.startsWith('#new') ? 'page' : 'false');
}
function roleView() {
    const id = selectedRole(), r = roles.find(r => r.id === id);
    document.querySelector('#manager-view')?.toggleAttribute('hidden', !!id);
    const view = document.querySelector<HTMLElement>('#native-view')!;
    view.hidden = !id;
    roleRail();
    if (!id)
        return;
    const frames = document.querySelector<HTMLElement>('#frames')!;
    frames.querySelectorAll<HTMLElement>('[data-frame]').forEach(f => f.hidden = f.dataset.frame !== id);
    const placeholder = document.querySelector<HTMLElement>('#role-placeholder')!;
    placeholder.hidden = !!r && alive(r);
    if (r && alive(r)) {
        let frame = frames.querySelector<HTMLIFrameElement>(`iframe[data-frame="${r.id}"]`);
        const requested = new URLSearchParams(location.hash.split('?')[1] || '').get('page');
        if (!frame) {
            frame = document.createElement('iframe');
            frame.dataset.frame = r.id;
            frame.title = r.name;
            frame.src = nativeURL(r, requested || '#/live');
            frames.append(frame);
        }
        else if (requested && frame.dataset.requested !== location.hash)
            frame.src = nativeURL(r, requested);
        frame.dataset.requested = location.hash;
        frame.hidden = false;
    }
    else {
        frames.querySelector(`[data-frame="${id}"]`)?.remove();
        placeholder.innerHTML = `<h2>${esc(r?.name || t('找不到角色'))}</h2>
<p>${r ? states[r.state] : ''}</p>${r ? startButton(r) : ''}<a class="btn" href="#">${t('返回管理入口')}</a>`;
        wireActions(placeholder);
    }
}
let roleRequest: Promise<Role[]> | undefined;
async function refreshRoles(force = false) {
    const next = await (roleRequest ??= api<Role[]>(manager('/roles')).finally(() => { roleRequest = undefined; }));
    if (!force && JSON.stringify(next) === JSON.stringify(roles))
        return;
    if (!current)
        return;
    roles = next;
    document.querySelectorAll<HTMLElement>('#frames [data-frame]').forEach(frame => {
        if (!roles.some(r => r.id === frame.dataset.frame && alive(r)))
            frame.remove();
    });
    roleRail();
    if (selectedRole())
        roleView();
    const list = document.querySelector('#role-list');
    if (list) {
        list.innerHTML = roles.map(manageCard).join('');
        wireActions(list);
        managementUI.tools(list);
    }
    const count = document.querySelector('#running-count');
    if (count)
        count.textContent = String(roles.filter(alive).length);
    const total = document.querySelector('#total-count');
    if (total)
        total.textContent = String(roles.length);
    if (location.hash.startsWith('#review/') && main().querySelector('[data-review]'))
        await reviewPage(location.hash.slice(8));
}
function shell() {
    const nav = (href: string, label: string, mark: string) => `<a class="navitem" href="${href}"><span class="navicon">${icon(mark)}</span><span>${label}</span></a>`;
    app.innerHTML = `<aside id="switch-rail"><a class="switch-button" id="manager-tab" href="#" title="${t('管理中心')}">${icon('home')}</a>
<div class="switch-divider">
</div>
<div id="role-tabs">
</div><a class="switch-button" id="create-tab" href="#new" title="${t('新建角色')}"><span class="rail-avatar-wrap"><span class="rail-avatar add-avatar">${icon('add')}</span></span></a></aside>
<section id="manager-view"><aside id="rail"><a class="brand" href="#">${wordmark()}</a><nav class="stack" aria-label="${t('管理导航')}">${nav('#', t('角色管理'), 'home') + nav('#new', t('新建角色'), 'plus') + nav('#schedules', t('定时运行'), 'calendar') + nav('#jobs', t('任务记录'), 'copy') + nav('#trash', t('已删除角色'), 'trash') + nav('#settings', t('界面设置'), 'settings')}</nav></aside><main id="main"></main>
</section>
<section id="native-view" hidden>
<div id="frames">
</div>
<div id="role-placeholder" hidden>
</div>
</section>`;
    roleRail();
}
const main = () => document.querySelector<HTMLElement>('#main')!;
function header(title: string, desc: string, action = '') {
    return `<header class="page-head">
<div>
<h1 class="pagetitle">${title}</h1>
<p class="pagedesc">${desc}</p>
</div>${action}</header>`;
}
async function route() {
    invalidatePage();
    const active = pageGuard();
    roleView();
    if (selectedRole())
        return;
    const hash = location.hash.slice(1);
    document.querySelectorAll<HTMLAnchorElement>('#rail nav a').forEach(a => {
        const selected = a.getAttribute('href') === '#' + (hash.startsWith('job/') ? 'jobs' : hash.startsWith('new?') ? 'new' : hash);
        a.classList.toggle('active', selected);
        if (selected)
            a.setAttribute('aria-current', 'page');
        else
            a.removeAttribute('aria-current');
    });
    try {
        if (hash === 'new' || hash.startsWith('new?'))
            await newPage();
        else if (hash === 'access' || hash === 'settings')
            accessPage();
        else if (hash === 'schedules')
            await managementUI.schedules();
        else if (hash === 'trash')
            await managementUI.trash();
        else if (hash.startsWith('review/'))
            await reviewPage(hash.slice(7));
        else if (hash.startsWith('job/'))
            await jobPage(hash.slice(4));
        else if (hash === 'jobs')
            await jobsPage();
        else if (hash.startsWith('stop/')) {
            const id = hash.slice(5);
            main().innerHTML = header(t("正在关机"), t("管理服务将保持在线。"));
            await api(`/api/roles/${id}/stop`, {});
            if (!active())
                return;
            location.hash = '';
        }
        else
            overview();
    }
    catch (e) {
        if (!active())
            return;
        main().innerHTML = header(t("操作未完成"), esc((e as Error).message)) + `<a class="btn" href="${managerURL()}">${t("返回管理入口")}</a>`;
    }
}
function manageCard(r: Role) {
    return `<article class="manage-card">
<div class="card-top">${avatar(r)}<div class="card-identity">
<h2>${esc(r.name)}</h2><small class="rail-runstate ${r.state}">${states[r.state]}</small>
</div>${actions(r)}</div><dl class="role-details">
<div><dt>${t("模板")}</dt><dd>${esc(r.bot)}</dd>
</div>
<div><dt>${t("后台端口")}</dt><dd>${r.port || '—'}</dd>
</div></dl>${r.error ? `<p class="error">${esc(r.error)}</p>` : ''}<div class="card-tools"><button class="btn" data-action="open" data-id="${r.id}">${t("打开后台")}</button><a class="btn" href="#new?source=${r.id}">${t("复制角色")}</a>${r.cloned ? `<a class="btn" href="#review/${r.id}">${t("启动前检查")}</a>` : ''}<button class="btn" data-schedule="${r.id}">${t("定时运行")}</button><button class="btn danger-text" data-delete="${r.id}">${t("删除")}</button>
</div>
</article>`;
}
function overview() {
    main().innerHTML = header(t("角色管理"), t("管理独立角色、复制设定、安排运行时间，或删除与恢复。"), `<a class="btn primary" href="#new">${icon('plus')}${t("新建角色")}</a>`) + `<div class="summary"><span><b id="running-count">${roles.filter(alive).length}</b>${t(" 个已启动")}</span><span><b id="total-count">${roles.length}</b>${t(" 个角色")}</span>
</div>
<section class="role-grid" id="role-list">${roles.map(manageCard).join('')}</section>`;
    wireActions(main());
    managementUI.tools(main());
}
const managementUI = management({ api, roles: () => roles, main, header, toast, confirm: confirmBox, refresh: () => refreshRoles(true) });
const creationUI = creation({ api, main, header, roles: () => roles, wireActions, toast });
const { newPage, jobPage, reviewPage, jobHTML, loadReviews } = creationUI;
const { jobsPage } = historyPages({ api, main, header, toast, confirm: confirmBox, managementUI });
async function boot() {
    {
        const auth = await api('/api/auth/status');
        if (auth.setupRequired) {
            setupPage();
            return;
        }
        if (!auth.authenticated) {
            login();
            return;
        }
    }
    try {
        current = await api('/api/current');
    }
    catch (e) {
        login((e as Error).message);
        return;
    }
    if (current)
        initTheme(await api('/api/theme'));
    shell();
    try {
        await refreshRoles();
        await route();
        if (poll)
            clearInterval(poll);
        poll = setInterval(() => void update().catch(() => { }), 1500);
    }
    catch (e) {
        main().innerHTML = header(t("连接角色管理"), esc((e as Error).message)) + `<p class="muted">${t("登录已失效，请重新登录管理中心后继续使用。")}</p><a class="btn primary" href="${managerURL()}">${t("打开管理入口")}</a>`;
    }
}
let updating = false;
async function update() {
    if (document.hidden || updating || !current)
        return;
    updating = true;
    try {
        await refreshRoles();
        if (!current)
            return;
        const detail = document.querySelector<HTMLElement>('#job-detail');
        if (detail) {
            const jobs = await api<Job[]>('/api/jobs'), j = jobs.find(j => j.id === detail.dataset.job);
            if (j && detail.isConnected) {
                const revision = JSON.stringify([j, roles.map(r => [r.id, r.state])]);
                if (detail.dataset.revision !== revision) {
                    detail.innerHTML = jobHTML(j);
                    wireActions(detail);
                    await loadReviews(detail);
                    detail.dataset.revision = revision;
                }
            }
        }
    }
    finally {
        updating = false;
    }
}
function passwordFields() {
    return `<label>${t("新密码")}<input class="field" name="password" type="password" autocomplete="new-password" minlength="8" maxlength="256" required>
</label>
<label>${t("再次输入新密码")}<input class="field" name="confirmPassword" type="password" autocomplete="new-password" minlength="8" maxlength="256" required>
</label>`;
}
function wirePasswordForm(setup: boolean) {
    app.querySelector<HTMLFormElement>('#password-form')!.addEventListener('submit', async (e) => {
        e.preventDefault();
        const form = e.currentTarget as HTMLFormElement, button = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
        button.disabled = true;
        try {
            await api(setup ? '/api/auth/setup' : '/api/auth/password', Object.fromEntries(new FormData(form)));
            form.reset();
            if (setup)
                await boot();
            else {
                clearInterval(poll);
                current = undefined;
                login(t("密码已修改，请使用新密码登录。"));
            }
        }
        catch (error) {
            form.querySelector('.error')!.textContent = t((error as Error).message);
        }
        finally {
            button.disabled = false;
        }
    });
}
function setupPage() {
    app.innerHTML = `<main class="login">
<form id="password-form" class="manager-sheet login-card">
<div class="eyebrow">CORTICO</div>
<h1>${t("设置访问密码")}</h1>
<p>${t("首次使用管理中心。此密码用于管理中心和它管理的所有角色后台。")}</p>${passwordFields()}<p class="error" role="alert">
</p><button type="submit" class="btn primary">${t("设置密码并进入")}</button>
</form></main>`;
    wirePasswordForm(true);
}
function accessPage() {
    main().innerHTML = header(t('界面设置'), '') + `<section class="manager-sheet form-sheet">
<h2>${t('通用')}</h2>
<div id="language-settings">
</div>
</section>
<section class="manager-sheet form-sheet">
<h2>${t('外观')}</h2>
<div id="appearance-settings">
</div>
</section>
<section class="manager-sheet form-sheet">
<h2>${t('访问密码')}</h2>
<p class="muted">${t('登录一次即可切换管理中心与所有角色后台。')}</p>
<form id="password-form">
<div class="password-fields">
<label>${t('当前密码')}<input class="field" name="currentPassword" type="password" autocomplete="current-password" required>
</label>${passwordFields()}</div>
<p class="muted">${t('修改密码或退出所有后台后，各设备需重新登录；角色继续运行。密码至少 8 个字符。')}</p>
<p class="error" role="alert">
</p>
<div class="password-actions"><button class="btn primary" type="submit">${t('保存新密码')}</button><button class="btn" type="button" id="logout">${t('退出所有后台')}</button>
</div>
</form>
</section>`;
    languageSettings(main().querySelector('#language-settings')!);
    appearanceSettings(main().querySelector('#appearance-settings')!, api, toast);
    wirePasswordForm(false);
    main().querySelector('#logout')!.addEventListener('click', async () => { await api('/api/auth/logout', {}); clearInterval(poll); current = undefined; login(); });
}
function login(message = '') {
    invalidatePage();
    app.innerHTML = `<main class="login">
<form class="manager-sheet login-card">
<div class="eyebrow">CORTICO</div>
<h1>${t("登录管理中心")}</h1>
<p>${t("管理角色与运行状态。")}</p>
<label>${t("访问密码")}<input class="field" type="password" name="password" autocomplete="current-password" required autofocus>
</label>
<p class="error" id="login-error">${esc(message)}</p><button class="btn primary">${t("登录 ")}${icon('arrow')}</button>
</form></main>`;
    app.querySelector('form')!.addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
            await api('/api/auth/login', { password: new FormData(e.currentTarget as HTMLFormElement).get('password') });
            await boot();
        }
        catch (err) {
            document.querySelector('#login-error')!.textContent = t((err as Error).message);
        }
    });
}
window.addEventListener('hashchange', () => {
    if (current)
        void route();
});
void boot().catch(error => { app.textContent = error.message; });
