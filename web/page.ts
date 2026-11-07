/** Ignore results belonging to a page that has since been left or replaced. */
let revision = 0;
export function invalidatePage() { revision++; }
export function pageGuard() {
    const started = revision, hash = location.hash;
    return () => started === revision && hash === location.hash;
}
export interface PageContext {
    api: <T = any>(path: string, body?: unknown) => Promise<T>;
    main: () => HTMLElement;
    header: (title: string, desc: string, action?: string) => string;
}
export function bind(root: ParentNode, selector: string, event: string, fn: (e: Event) => void) {
    root.querySelectorAll(selector).forEach(el => el.addEventListener(event, fn));
}
