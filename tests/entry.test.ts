import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { roleEntry } from '../src/gateway.ts';

test('direct role entry keeps hostname and page while switching to the manager', () => {
    for (const host of ['127.0.0.1', 'example.local', '[::1]']) {
        for (const hash of ['', '#/providers', '#/provider/world%3Aconsole']) {
            let destination = '';
            const location = { href: `http://${host}:19001/${hash}`, hash, replace: (url: string) => { destination = url; } };
            const script = roleEntry('alpha', 19000).match(/<script>([\s\S]*)<\/script>/)![1];
            runInNewContext(script, { URL, location });
            const result = new URL(destination);
            assert.equal(result.host, `${host}:19000`);
            assert.equal(result.pathname, '/');
            assert.ok(result.hash.startsWith('#role/alpha?'));
            assert.equal(new URLSearchParams(result.hash.split('?')[1]).get('page'), hash || '#/live');
        }
    }
});
