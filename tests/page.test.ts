import test from 'node:test';
import assert from 'node:assert/strict';
import { invalidatePage, pageGuard } from '../web/page.ts';

// A delayed response must not render into the page opened after it was requested.
test('late page responses leave the new page untouched', async () => {
    const location = { hash: '#new' };
    const saved = new Map<string, PropertyDescriptor | undefined>();
    const globals = { location, localStorage: { getItem: () => 'zh' }, document: { documentElement: { lang: '' } } };
    for (const [key, value] of Object.entries(globals)) {
        saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
        Object.defineProperty(globalThis, key, { configurable: true, value });
    }
    try {
        const { creation } = await import('../web/creation.ts');
        const { historyPages } = await import('../web/history.ts');
        const { management } = await import('../web/management.ts');
        const { startButton, pendingStarts } = await import('../web/role-ui.ts');
        const role = { id: 'test', name: 'Test', bot: 'cormini', port: 19001, avatar: false, state: 'stopped' as const };
        assert.doesNotMatch(startButton(role), /class="spinner"/);
        pendingStarts.add(role.id);
        assert.match(startButton(role), /aria-busy="true"[^>]*disabled/);
        assert.match(startButton(role, '启动', 'rail-action', true), /class="spinner"/);
        pendingStarts.delete(role.id);
        assert.match(startButton({ ...role, state: 'starting' }), /class="spinner"/);
        assert.doesNotMatch(startButton({ ...role, state: 'error' }), /disabled/);
        let requests: Array<() => void> = [];
        const context = {
            api: <T = any>() => new Promise<T>(resolve => requests.push(() => resolve([] as T))),
            main: (): HTMLElement => { throw Error('Stale page tried to render'); },
            header: () => '', roles: () => [], wireActions: () => {}, toast: () => {},
            confirm: async () => false, refresh: async () => {},
        };
        const create = creation(context), manage = management(context);
        const history = historyPages({ ...context, managementUI: manage });
        for (const [hash, render] of [
            ['#new', () => create.newPage()],
            ['#job/test', () => create.jobPage('test')],
            ['#jobs', () => history.jobsPage()],
            ['#trash', () => manage.trash()],
            ['#schedules', () => manage.schedules()],
        ] as const) {
            location.hash = hash;
            invalidatePage();
            const pending = render();
            assert.ok(requests.length > 0);
            location.hash = '#settings';
            invalidatePage();
            requests.forEach(resolve => resolve());
            requests = [];
            await pending;
        }
        location.hash = '#new';
        const previous = pageGuard();
        invalidatePage(); // Leaving and returning to the same URL still invalidates the old request.
        assert.equal(previous(), false);
    } finally {
        for (const [key, descriptor] of saved) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else Reflect.deleteProperty(globalThis, key);
        }
    }
});
