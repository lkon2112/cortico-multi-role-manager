import { resolve } from 'node:path';
import { createManager } from './server.ts';
const args = process.argv.slice(2);
const option = (name: string, fallback = '') => { const at = args.indexOf(`--${name}`); return at < 0 ? fallback : args[at + 1]; };
if (args.includes('--help') || !option('cortico')) {
    console.log('npm start -- --cortico /path/to/Cortico --data ./data --host 127.0.0.1 --port 19000');
    process.exit(args.includes('--help') ? 0 : 1);
}
const port = Number(option('port', '19000')), host = option('host', '127.0.0.1');
if (!Number.isInteger(port) || port < 1024 || port > 64535)
    throw Error('管理端口须为 1024–64535');
const manager = await createManager({ source: resolve(option('cortico')), root: resolve(option('data', 'data')), port, host });
console.log(`Cortico Multi-Role Manager: http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}/`);
let closing = false;
const close = async () => { if (closing)
    return; closing = true; try {
    await manager.close();
    process.exit(0);
}
catch (error) {
    console.error(error);
    closing = false;
} };
process.on('SIGINT', close);
process.on('SIGTERM', close);
