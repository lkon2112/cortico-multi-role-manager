import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
export function json<T = any>(file: string, fallback?: T): T { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback as T; }
export function validId(id: string) { return /^[a-z][a-z0-9-]{0,47}$/.test(id); }
export function writeJson(file: string, value: unknown) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file + '.tmp', JSON.stringify(value, null, 2)); renameSync(file + '.tmp', file); }
