// Probe only: the official runtime has no real endpoint or external World configured.
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, options) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (!['127.0.0.1','localhost','[::1]'].includes(url.hostname)) return Promise.reject(new Error('External network disabled in independence probe'));
  return originalFetch(input, options);
};
