// ai/normalize-ai.ts
const KNOWN_TYPES = new Set(['mcq', 'msq', 'tf', 'short', 'cloze', 'match', 'order']);

function tryParseJson(anything: any): any | null {
    if (anything == null) return null;
    if (typeof anything === 'object') return anything;
    if (typeof anything !== 'string') return null;

    // přímý parse
    try { return JSON.parse(anything); } catch { }
    // vytáhni největší {...}
    const start = anything.indexOf('{'); const end = anything.lastIndexOf('}');
    if (start >= 0 && end > start) {
        try { return JSON.parse(anything.slice(start, end + 1)); } catch { }
    }
    return null;
}

function getRootArray(obj: any): any[] {
    if (!obj) return [];
    if (Array.isArray(obj)) return obj;
    if (Array.isArray(obj.questions)) return obj.questions;
    if (Array.isArray(obj.qs)) return obj.qs;          // ← tvoje varianta
    if (Array.isArray(obj.items)) return obj.items;
    if (Array.isArray(obj.data)) return obj.data;
    return [];
}

function asBool(x: any): boolean | undefined {
    if (typeof x === 'boolean') return x;
    if (typeof x === 'string') return x.trim().toLowerCase() === 'true';
    return undefined;
}

function coerceOne(q: any) {
    if (!q || typeof q !== 'object') return null;

    // typ & text (řešíme prohození: t='short', q='text', k='q1' apod.)
    let type = (q.k ?? q.type ?? q.kind ?? q.t ?? '').toString().toLowerCase();
    let text = q.t ?? q.q ?? q.text ?? '';

    if (!KNOWN_TYPES.has(type)) {
        const maybeType = (q.t ?? '').toString().toLowerCase();
        const maybeText = q.q ?? '';
        if (KNOWN_TYPES.has(maybeType) && maybeText) {
            type = maybeType;
            text = maybeText;
        }
    }

    // odpověď
    let r = q.r ?? q.rs ?? q.answer ?? q.a ?? null;

    // volby & správné indexy
    const choices: string[] = (q.o ?? q.options ?? q.choices ?? []).map((x: any) => String(x ?? ''));
    let ci: number[] = Array.isArray(q.ci) ? q.ci
        : Array.isArray(q.correctIndices) ? q.correctIndices
            : Array.isArray(q.correctIndex) ? [q.correctIndex]
                : Array.isArray(q.correct) && typeof q.correct[0] === 'number' ? q.correct
                    : [];

    // když přišel seznam správných odpovědí jako stringy, převeď na indexy
    if (!ci.length && Array.isArray(q.correct)) {
        const asStrings = q.correct.every((v: any) => typeof v === 'string');
        if (asStrings && choices.length) {
            ci = (q.correct as string[])
                .map((ans) => choices.findIndex((c) => c === ans))
                .filter((i) => i >= 0);
        }
    }

    // tf: proveď na bool, kdyby to byl string
    if (type === 'tf' && typeof r !== 'boolean') {
        const b = asBool(r);
        if (typeof b === 'boolean') r = b;
    }

    // meta
    const s = q.s ?? {};
    const chunkId = s.c ?? q.chunkId ?? q.c ?? undefined;
    const fileId = s.f ?? q.fileId ?? q.f ?? undefined;

    const out: any = {
        k: type,         // typ
        t: String(text ?? ''), // text otázky
        o: choices,      // volby (MCQ/MSQ)
        ci,              // indexy správných
        r,               // odpověď (short/tf/cloze/match/order různě)
        s: { c: chunkId, f: fileId },
    };

    // základní validace
    if (!KNOWN_TYPES.has(out.k)) return null;
    if (!out.t || typeof out.t !== 'string') return null;

    return out;
}

export function normalizeAiQuestions(raw: unknown): any[] {
    // raw může být: string JSON, objekt s questions/qs, nebo rovnou pole
    const root = tryParseJson(raw) ?? raw;
    const arr = getRootArray(root);
    return arr.map(coerceOne).filter(Boolean);
}
