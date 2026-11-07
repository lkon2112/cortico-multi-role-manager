import { t, locale } from './i18n.ts';
import { esc } from './role-ui.ts';
import { icon } from './icons.ts';
import type { Job } from '../src/types.ts';
import type { management } from './management.ts';
import { bind, pageGuard, type PageContext } from './page.ts';
interface Context extends PageContext {
    toast: (text: string) => void;
    confirm: (title: string, body: string) => Promise<boolean>;
    managementUI: ReturnType<typeof management>;
}
export function historyPages({ api, main, header, toast, confirm: confirmBox, managementUI }: Context) {
    let recordPages = [1, 1];
    let recordPageSize = Number(localStorage.getItem('manager-record-page-size')) || 10;
    if (![10, 20, 50].includes(recordPageSize))
        recordPageSize = 10;
    function recordPager(total: number, index: number) {
        const pages = Math.max(1, Math.ceil(total / recordPageSize));
        const page = recordPages[index] = Math.min(recordPages[index], pages);
        const first = total ? (page - 1) * recordPageSize + 1 : 0;
        return `<div class="record-pagination"><span>${t("显示 ")}${first}${t(" 至 ")}${Math.min(page * recordPageSize, total)}${t("，共 ")}${total}${t(" 条")}</span>
<label>${t("每页 ")}<select class="field" data-page-size>${[10, 20, 50].map(n => `<option ${n === recordPageSize ? 'selected' : ''}>${n}</option>`).join('')}</select>
</label>
<div class="record-pages"><button class="btn" data-page="${index}" data-step="-1" ${page === 1 ? 'disabled' : ''} aria-label="${t("上一页")}">‹</button><span>${page} / ${pages}</span><button class="btn" data-page="${index}" data-step="1" ${page === pages ? 'disabled' : ''} aria-label="${t("下一页")}">›</button>
</div>
</div>`;
    }
    async function jobsPage() {
        const active = pageGuard();
        if (location.hash !== '#jobs')
            return;
        const [jobs, records, settings] = await Promise.all([api<Job[]>('/api/jobs'), api('/api/operations'), api('/api/history/settings')]);
        if (!active())
            return;
        const pagers = [recordPager(jobs.length, 0), recordPager(records.length, 1)];
        const visibleJobs = jobs.slice((recordPages[0] - 1) * recordPageSize, recordPages[0] * recordPageSize);
        const visibleRecords = records.slice((recordPages[1] - 1) * recordPageSize, recordPages[1] * recordPageSize);
        main().innerHTML = header(t("任务记录"), t("查看创建进度、运行操作和定时执行结果；失败记录保留具体原因。"), `<div class="history-actions"><button class="btn" id="refresh-records">${t("刷新记录")}</button><button class="btn" id="clear-records" >${t("清空记录")}</button>
</div>`) + `<form class="history-settings" id="history-settings">
<label>${t("每类最多保留 ")}<input class="field" name="limit" type="number" min="10" max="10000" step="1" required value="${settings.limit}">${t(" 条已结束记录")}</label><button class="btn" >${t("保存")}</button><span class="muted">${t("超出后自动清理最旧记录；进行中的任务保留。")}</span>
</form>
<h2 class="section-heading">${t("创建与复制")}</h2>
<section class="manager-sheet record-list">${jobs.length ? visibleJobs.map(j => `<a class="record-row" href="#job/${j.id}">
<div>
<h3>${esc(j.input.name)}</h3>
<p class="muted">${j.input.source ? t("复制角色") : t("全新创建")} · ${j.status === 'done' ? t("已完成") : j.status === 'working' ? t("进行中") : t("需处理")} · ${j.steps[0] ? new Date(j.steps[0].at).toLocaleString(locale) : ''}</p>${j.error ? `<p class="error">${esc(t(j.error))}</p>` : ''}</div><span class="record-detail">${t("查看详情 ")}${icon('arrow')}</span></a>`).join('') : `<p class="empty">${t("还没有创建任务。")}</p>`}${pagers[0]}</section>
<h2 class="section-heading">${t("运行与定时操作")}</h2>
<section class="manager-sheet record-list">${records.length ? managementUI.records(visibleRecords) : `<p class="empty">${t("还没有运行操作记录。")}</p>`}${pagers[1]}</section>`;
        main().querySelector('#refresh-records')!.addEventListener('click', () => void jobsPage());
        bind(main(), '[data-page]', 'click', e => {
            const b = e.currentTarget as HTMLButtonElement;
            recordPages[Number(b.dataset.page)] += Number(b.dataset.step);
            void jobsPage();
        });
        bind(main(), '[data-page-size]', 'change', e => {
            recordPageSize = Number((e.currentTarget as HTMLSelectElement).value);
            localStorage.setItem('manager-record-page-size', String(recordPageSize));
            recordPages = [1, 1];
            void jobsPage();
        });
        main().querySelector('#history-settings')!.addEventListener('submit', async (e) => {
            e.preventDefault();
            const limit = Number(new FormData(e.currentTarget as HTMLFormElement).get('limit'));
            if (limit < settings.limit && !await confirmBox(t("减少保留条数？"), t("超出新上限的最旧记录会被清理，角色数据与定时计划保持不变。")))
                return;
            try {
                await api('/api/history/settings', { limit });
                await jobsPage();
                toast(t("保留条数已保存"));
            }
            catch (e) {
                toast((e as Error).message);
            }
        });
        main().querySelector('#clear-records')!.addEventListener('click', async () => {
            if (!await confirmBox(t("清空任务记录？"), t("清除创建、复制与运行操作的已结束记录，无法恢复。保留进行中的任务，角色数据与定时计划保持不变。")))
                return;
            try {
                await api('/api/history/clear', {});
                recordPages = [1, 1];
                await jobsPage();
                toast(t("记录已清空"));
            }
            catch (e) {
                toast((e as Error).message);
            }
        });
        managementUI.wireRecords(main(), jobsPage);
    }
    return { jobsPage };
}
