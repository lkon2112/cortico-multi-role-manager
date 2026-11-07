// Original Cortico SVG artwork, copied unchanged under MIT; see LICENSE.cortico.
import { icon as originalIcon, wordmark as originalWordmark, type WebUiIconName } from './vendor/icons.ts';
const aliases: Record<string, WebUiIconName> = { chat: 'message', book: 'folder-open', triangle: 'play', arrow: 'play', plus: 'bot', check: 'shield-check' };
export function icon(name: string): string {
    const path = name === 'add' ? 'M12 5v14M5 12h14' : undefined;
    return path ? `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${path}"/></svg>` : originalIcon(document, aliases[name] || name as WebUiIconName).outerHTML;
}
export function wordmark(): string { return originalWordmark(document).outerHTML; }
