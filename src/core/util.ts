const _ON = "bdgklmnrstvz",
    _CO = "lnrsk",
    _V = "aeiou";

function _pick(pool: string) {
    return pool[Math.floor(Math.random() * pool.length)];
}

function _word() {
    const n = Math.random() < 0.15 ? 1 : Math.random() < 0.6 ? 2 : 3;
    let w = "";
    for (let i = 0; i < n; i++) {
        w += _pick(_ON) + _pick(_V);
        if (i === n - 1 && Math.random() < 0.45) w += _pick(_CO);
    }
    return w;
}

function _cap(s: string) {
    return s[0].toUpperCase() + s.slice(1);
}

export function hashSeedWord(s: string): number {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
    return Math.abs(h) % 100000;
}

// Yield to the event loop so frames and input can run between slices of long CPU work. setTimeout(0) is clamped to
// ≥ 4 ms once nested, so a "work 4 ms, yield" loop sat idle about half its wall time; scheduler.yield (Chrome/Edge 129+)
// and a MessageChannel post resume as soon as the browser is free. setTimeout stays as the last-resort fallback.
const channel = typeof MessageChannel === "function" ? new MessageChannel() : null,
    waiting: (() => void)[] = [];
if (channel) channel.port1.onmessage = () => waiting.shift()?.();
export function yieldTask(): Promise<void> {
    const sched = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
    if (sched?.yield) return sched.yield();
    return new Promise((r) => {
        if (!channel) return setTimeout(r);
        waiting.push(r);
        channel.port2.postMessage(0);
    });
}
/** Returns `await slice()`-able checkpoint: yields once `ms` of work has run since the last yield, else returns at once. */
export function slicer(ms = 4) {
    let last = performance.now();
    return async () => {
        if (performance.now() - last < ms) return;
        await yieldTask();
        last = performance.now();
    };
}

export function genSeedWord(): string {
    const n = Math.random() > 0.8 ? 1 : Math.random() > 0.4 ? 2 : 3;
    return Array.from({ length: n }, () => _cap(_word())).join("");
}
