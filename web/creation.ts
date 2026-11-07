import { t, locale } from './i18n.ts';
import { esc, states, alive, startButton } from './role-ui.ts';
import { icon } from './icons.ts';
import { copiesRuntime, type Role, type Job, type CopyOptions, type CloneReview } from '../src/types.ts';
import { bind, pageGuard, type PageContext } from './page.ts';
interface Context extends PageContext {
    roles: () => Role[];
    wireActions: (root: ParentNode) => void;
    toast: (text: string) => void;
}
export function creation({ api, main, header, roles, wireActions, toast }: Context) {
    const copyFields: [
        keyof CopyOptions,
        string,
        string
    ][] = [['memory', t("长期记忆与人格状态"), t("笔记、关系、意图、交接笔记和人格状态")], ['session', t("当前会话"), t("保留上下文，并携带关联事件与图片附件")], ['history', t("历史记录与用量"), t("运行记录、事件、工具调用和用量")], ['timers', t("待办与定时任务"), t("自动包含人格记忆；过期任务可能在启动时触发")], ['pending', t("待处理消息"), t("自动包含记忆、会话、历史及 World 本地状态")], ['worldState', t("World 本地状态"), t("复制本地关系、进度等已适配的数据")]];
    async function newPage() {
        const active = pageGuard();
        const templates = await api<any[]>('/api/templates');
        if (!active())
            return;
        main().innerHTML = header(t("新建角色"), t("全新开始，或从现有角色的一个时间点继续。")) + `<form id="new-form">
<section class="manager-sheet form-sheet">
<div class="mode-grid">
<label class="mode"><input type="radio" name="mode" value="fresh" checked>${icon('plus')}<span><strong>${t("全新创建")}</strong><small>${t("选择模板，从空白记忆开始")}</small></span>
</label>
<label class="mode"><input type="radio" name="mode" value="copy" ${roles().length ? '' : 'disabled'}>${icon('copy')}<span><strong>${t("从现有角色复制")}</strong><small>${t("按需保留设定、记忆与会话")}</small></span>
</label>
</div>
<div class="field-grid">
<label>${t("角色名称")}<input class="field" name="name" placeholder="${t("给新角色起个名字")}" required maxlength="80">
</label>
<label>${t("部署目录名")}<input class="field" name="id" placeholder="${t("例如：my-character")}" required pattern="[a-z][a-z0-9-]{0,47}" maxlength="48"><small>${t("小写字母、数字、短横线；创建后保持不变")}</small>
</label>
</div>
<label id="template-label">${t("Bot 模板")}<select class="field" name="bot">${templates.map(template => `<option value="${esc(template.id)}">${esc(t(template.label))}</option>`).join('')}</select>
</label>
<div id="source-wrap" hidden>
<label>${t("来源角色")}<select class="field" name="source">${roles().map(r => `<option value="${esc(r.id)}">${esc(r.name)} · ${states[r.state]}</option>`).join('')}</select>
</label>
</div>
</section>
<section id="copy-section" class="manager-sheet form-sheet" hidden>
<h2>${t("复制内容")}</h2>
<div class="copy-mode-switch">
<label><input type="radio" name="copyMode" value="selective" checked>${t("按需复制")}</label>
<label><input type="radio" name="copyMode" value="full">${t("完整本地克隆")}</label>
</div>
<p id="full-copy-description" class="clone-note" hidden>${t("复制部署目录内的全部文件，包括插件数据和外部账号。部署目录外的数据及已安装扩展仍共用原位置。")}</p>
<div id="selective-options">
<p class="copy-help">${t("设定、提示词和外观始终保留。其余由你选择。")}</p>
<div class="check-grid">${copyFields.map(([key, label, desc]) => `<label class="check-option"><input type="checkbox" name="${key}"><span><strong>${label}</strong><small>${desc}</small></span>
</label>`).join('')}</div>
<p class="copy-help">${t("第三方插件的额外文件需配置复制规则后，才会纳入复制。")}</p>
<div class="connections">
<h3>${t("外部账号与连接凭据")}</h3>
<p>${t("复制后会使用同一个外部账号，不会生成新的外部身份。")}</p>
<div id="connections">
</div>
</div>
</div>
<p id="copy-data-notice" class="clone-note copy-data-notice" role="status" hidden>
</p>
<div class="clone-note">${t("端口和进程锁会重新生成；复制后的角色保持停止，并共用管理登录。")}</div>
<div class="copy-stop-notice" id="copy-stop-notice" role="status" hidden>${icon('alert')}<div><strong>${t("创建时将短暂关闭来源角色")}</strong>
<p>${t("所选内容包含运行中的数据。复制完成后自动恢复来源角色；本页面会保持打开。")}</p>
</div>
</div>
<p class="muted small">${t("任务由常驻管理服务执行，刷新或关闭此页面不会取消任务。")}</p>
</section>
<div class="form-bottom"><span id="form-error" class="error" role="alert"></span><a class="btn" href="#">${t("取消")}</a><button class="btn primary" type="submit">${t("创建角色 ")}${icon('arrow')}</button>
</div>
</form>`;
        const form = main().querySelector<HTMLFormElement>('#new-form')!, copySection = main().querySelector<HTMLElement>('#copy-section')!, sourceWrap = main().querySelector<HTMLElement>('#source-wrap')!, templateLabel = main().querySelector<HTMLElement>('#template-label')!;
        let info: any = null, copyError = "";
        const field = (name: string) => form.elements.namedItem(name) as HTMLInputElement;
        const fullCopy = () => new FormData(form).get('copyMode') === 'full';
        async function sourceChanged() {
            info = null;
            copyError = "";
            updateStopNotice();
            const selected = field('source').value;
            try {
                const result = await api(`/api/roles/${selected}/clone-info`);
                if (!active() || !form.isConnected || field('source').value !== selected)
                    return;
                info = result;
                field('bot').value = info.bot;
                form.querySelector('#connections')!.innerHTML = info.connections.map((c: any) => `<label class="connection-check"><input type="checkbox" name="connection" value="${esc(c.id)}">${esc(t(c.label))}</label>`).join('');
            }
            catch (e) {
                if (!active() || !form.isConnected || field('source').value !== selected)
                    return;
                copyError = t((e as Error).message);
            }
            updateStopNotice();
        }
        bind(form, 'input[name=mode]', 'change', () => {
            const copying = new FormData(form).get('mode') === 'copy';
            copySection.hidden = !copying;
            sourceWrap.hidden = !copying;
            templateLabel.hidden = copying;
            if (copying)
                void sourceChanged();
            else
                updateStopNotice();
        });
        field('source').addEventListener('change', () => void sourceChanged());
        function updateStopNotice() {
            const source = roles().find(r => r.id === field('source').value);
            const copy = Object.fromEntries(copyFields.map(([key]) => [key, field(key).checked]));
            const required = new FormData(form).get('mode') === 'copy' && !!source && alive(source) && (fullCopy() || copiesRuntime(copy));
            form.querySelector<HTMLElement>('#copy-stop-notice')!.hidden = !required;
            const submit = form.querySelector<HTMLButtonElement>('button[type=submit]')!;
            submit.textContent = required ? t("创建角色（来源将短暂关机）") : t("创建角色");
            const extra: string[] = info?.extraData ?? [];
            const notice = form.querySelector<HTMLElement>('#copy-data-notice')!;
            const error = copyError || (fullCopy() ? info?.fullError : info?.selectiveError) || '';
            notice.hidden = !error && (fullCopy() || !extra.length);
            notice.textContent = error || (extra.length ? t("未适配的数据：{0}。勾选 World 本地状态前需补充复制规则；不勾选则跳过这些文件。", extra.join('、')) : '');
            submit.disabled = new FormData(form).get('mode') === 'copy' && (!info || !!error || (!fullCopy() && !!extra.length && field('worldState').checked));
        }
        function syncDependencies() {
            const pending = field('pending').checked, timers = field('timers').checked;
            for (const key of ['memory', 'session', 'history', 'worldState']) {
                const required = pending || (key === 'memory' && timers);
                field(key).disabled = required;
                if (required)
                    field(key).checked = true;
            }
            updateStopNotice();
        }
        bind(form, '.check-option input', 'change', syncDependencies);
        function changeCopyMode() {
            form.querySelector<HTMLElement>('#selective-options')!.hidden = fullCopy();
            form.querySelector<HTMLElement>('#full-copy-description')!.hidden = !fullCopy();
            updateStopNotice();
        }
        bind(form, 'input[name=copyMode]', 'change', changeCopyMode);
        const query = new URLSearchParams(location.hash.split('?')[1] || '');
        const previous = query.has('retry') ? (await api<Job[]>('/api/jobs')).find(j => j.id === query.get('retry')) : undefined;
        if (!active())
            return;
        const source = previous?.input.source || query.get('source');
        if (previous) {
            field('name').value = previous.input.name;
            field('id').value = previous.input.id;
            field('bot').value = previous.input.bot;
        }
        if (source && roles().some(r => r.id === source)) {
            (form.querySelector('input[name=mode][value=copy]') as HTMLInputElement).checked = true;
            copySection.hidden = false;
            sourceWrap.hidden = false;
            templateLabel.hidden = true;
            field('source').value = source;
            await sourceChanged();
            if (!active())
                return;
            if (previous) {
                copyFields.forEach(([key]) => field(key).checked = !!previous.input.copy[key]);
                form.querySelectorAll<HTMLInputElement>('[name=connection]').forEach(e => e.checked = previous.input.copy.connections.includes(e.value));
                (form.querySelector(`input[name=copyMode][value=${previous.input.copyMode || 'selective'}]`) as HTMLInputElement).checked = true;
                changeCopyMode();
                syncDependencies();
            }
        }
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            const submit = form.querySelector<HTMLButtonElement>('button[type=submit]')!, error = form.querySelector('#form-error')!;
            error.textContent = '';
            submit.disabled = true;
            try {
                const data = new FormData(form), copying = data.get('mode') === 'copy', copy: any = { connections: copying ? data.getAll('connection') : [] };
                copyFields.forEach(([key]) => copy[key] = copying && field(key).checked);
                const job = await api<Job>('/api/jobs', { id: data.get('id'), name: data.get('name'), bot: field('bot').value, source: copying ? data.get('source') : undefined, copy, copyMode: copying && fullCopy() ? 'full' : 'selective', allowStop: copying && (fullCopy() || copiesRuntime(copy)) });
                if (active())
                    location.hash = `job/${job.id}`;
            }
            catch (err) {
                error.textContent = t((err as Error).message);
                submit.disabled = false;
            }
        });
    }
    function jobHTML(j: Job) {
        const source = roles().find(r => r.id === j.input.source);
        const result = roles().find(r => r.id === j.result);
        return `<section class="manager-sheet job-sheet">
<div class="job-status ${j.status}">${j.status === 'working' ? '<span class="spinner"></span>' : icon(j.status === 'done' ? 'check' : 'close')}<h2>${j.status === 'working' ? t("正在创建") : j.status === 'done' ? t("角色已创建") : t("任务需要处理")}</h2>
</div>
<p>${esc(j.input.name)}${j.input.source ? t(" · 从 ") + esc(source?.name || j.input.source) + t(" 复制") : ''}</p>${j.input.source ? `<p class="small muted">${j.input.copyMode === 'full' ? t("完整本地克隆") : t("复制范围：设定、提示词和外观")}${(j.input.copyMode === 'full' ? [] : copyFields).filter(([k]) => j.input.copy[k]).map(([, label]) => ' · ' + label).join('')}${j.input.copyMode !== 'full' && j.input.copy.connections.length ? t(" · 外部连接：") + j.input.copy.connections.map(esc).join('、') : ''}</p>` : ''}<ol class="steps">${j.steps.map(s => `<li><span>${esc(t(s.label))}</span><time>${new Date(s.at).toLocaleTimeString(locale, { hour12: false })}</time>
</li>`).join('')}</ol>${j.error ? `<p class="error">${esc(t(j.error))}</p>` : ''}${j.status !== 'working' && j.input.source && j.result && result ? `<div class="clone-review" data-review="${esc(j.result)}">
</div>` : ''}${j.status !== 'working' ? `<div class="job-links"><a class="btn primary" href="#">${t("查看角色列表")}</a>${j.result && !j.input.source && result ? (alive(result) ? `<button class="btn" data-action="open" data-id="${esc(j.result)}">${t("打开角色后台")}</button>` : startButton(result, t("启动新角色"), "btn")) : ''}${j.status === 'failed' && !j.result ? `<a class="btn" href="#new?retry=${j.id}">${t("按原参数重新编辑")}</a>` : ''}${j.input.source && source ? (alive(source) ? `<button class="btn" data-action="open" data-id="${esc(j.input.source)}">${t("返回来源角色后台")}</button>` : startButton(source, t("启动来源角色"), "btn")) : ''}</div>` : `<p class="muted">${t("可以刷新或关闭页面，任务会继续执行。")}</p>`}</section>`;
    }
    async function jobPage(id: string) {
        const active = pageGuard();
        const jobs = await api<Job[]>('/api/jobs'), j = jobs.find(j => j.id === id);
        if (!active())
            return;
        if (!j)
            throw new Error(t("找不到任务记录"));
        main().innerHTML = header(t("创建进度"), t("新角色会保持停止，来源角色按原状态恢复。")) + `<div id="job-detail" data-job="${esc(id)}">${jobHTML(j)}</div>`;
        wireActions(main());
        await loadReviews(main());
    }
    function reviewAction(id: string) {
        const role = roles().find(r => r.id === id)!;
        return alive(role) ? `<button class="btn primary" data-action="open" data-id="${esc(id)}">${t("打开角色后台")}</button>` : startButton(role, t('启动新角色'));
    }
    function reviewHTML(id: string, review: CloneReview, standalone: boolean) {
        const stopped = roles().find(r => r.id === id)?.state === 'stopped';
        return `${standalone ? '' : `<div class="review-heading">
<h2>${t("启动前检查")}</h2>${reviewAction(id)}</div>`}<p class="copy-help">${t("启动角色会同时连接已启用的 World。请先检查下方开关，避免重复连接同一账号。开关仅修改此副本，关闭后保留数据。")}</p>${review.notes.map(note => `<p class="clone-note">${esc(t(note))}</p>`).join('')}${review.externalLinks.length ? `<p class="clone-note">${t("仍引用外部文件的链接：")}${review.externalLinks.map(esc).join('、')}</p>` : ''}<div class="review-worlds">${review.worlds.map(w => `<div class="review-world">
<div><strong>${esc(w.id)}</strong><span class="small muted">${w.enabled ? t("已启用") : t("已停用")}</span><ul>${w.hints.map(h => `<li>${esc(t(h))}</li>`).join('')}</ul>${w.fields.length ? `<p class="copy-help">${t("配置项：")}${w.fields.map(esc).join(' · ')}</p>` : ''}</div><button type="button" class="world-switch" role="switch" aria-label="${esc(w.id)} World" aria-checked="${w.enabled}" data-world="${esc(w.id)}" ${stopped ? '' : 'disabled'}><span></span></button>
</div>`).join('')}</div>${!stopped ? `<p class="copy-help">${t("修改 World 前请先关闭此副本。")}</p>` : ''}`;
    }
    async function loadReviews(container: ParentNode) {
        for (const panel of container.querySelectorAll<HTMLElement>('[data-review]')) {
            const id = panel.dataset.review!;
            try {
                const review = await api<CloneReview>(`/api/roles/${id}/clone-review`);
                if (!panel.isConnected)
                    continue;
                panel.innerHTML = reviewHTML(id, review, panel.classList.contains('standalone-review'));
                wireActions(panel);
                panel.querySelectorAll<HTMLButtonElement>('[data-world]').forEach(button => button.onclick = async () => {
                    const enabled = button.getAttribute('aria-checked') !== 'true';
                    button.disabled = true;
                    try {
                        await api(`/api/roles/${id}/world-enabled`, { world: button.dataset.world, enabled });
                        if (panel.isConnected)
                            await loadReviews(panel.parentElement!);
                        toast(t(enabled ? "已启用" : "已停用"));
                    }
                    catch (e) {
                        button.disabled = false;
                        toast(t((e as Error).message));
                    }
                });
            }
            catch (e) {
                panel.innerHTML = `<p class="error">${esc(t((e as Error).message))}</p>`;
            }
        }
    }
    async function reviewPage(id: string) {
        const role = roles().find(r => r.id === id);
        if (!role)
            throw Error(t("找不到角色"));
        main().innerHTML = header(t("启动前检查"), esc(role.name), `<div class="review-actions"><a class="btn" href="#">${t("查看角色列表")}</a>${reviewAction(id)}</div>`) + `<section class="manager-sheet form-sheet">
<div class="clone-review standalone-review" data-review="${esc(id)}">
</div>
</section>`;
        wireActions(main());
        await loadReviews(main());
    }
    return { newPage, jobPage, reviewPage, jobHTML, loadReviews };
}
