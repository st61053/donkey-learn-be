// src/ai/chunk-selector.service.ts
import { Injectable, Logger } from '@nestjs/common';

/** Vstupní reprezentace chunku (přichází zvenku). */
export type SelChunk = { id: string; text: string; fileId?: string; index?: number };

/** Interně normalizovaný chunk (stejná, volitelná signatura). */
type NormalizedChunk = { id: string; text: string; fileId?: string; index?: number };

/** Parametry výběru chunků. */
export interface SelectOpts {
    perFileCap: number;
    globalCap: number;
    windowSize: number;
    coalesceMaxChars?: number;
    coalesceMinChars?: number;
}

/**
 * Heuristický výběr „nejlepších“ chunků:
 * - koalescence sousedů (zachování lokálního kontextu),
 * - skórování (definice, principy, rovnice, struktura…),
 * - deduplikace (fingerprint),
 * - stratifikace napříč soubory (top-K per file),
 * - doplnění do globalCap + rozdělení do oken.
 */
@Injectable()
export class ChunkSelectorService {
    private readonly logger = new Logger(ChunkSelectorService.name);

    private readonly POSITIVE_HINTS = [
        'definice', 'definuje', 'princip', 'vlastnost', 'postup', 'algoritmus',
        'vzorec', 'rovnice', 'výhoda', 'nevýhoda', 'příklad', 'shrnutí',
        'characteristics', 'definition', 'advantages', 'disadvantages',
        'theorem', 'lemma', 'proof', 'equation', 'derivation', 'assumption',
    ];

    private readonly NEGATIVE_HINTS = [
        'obsah', 'table of contents', 'kontakt', 'kontaktujte', 'copyright',
        'all rights reserved', 'cookies', 'newsletter', 'subscribe',
        'disclaimer', 'terms of use', 'privacy policy', 'navigace',
    ];

    /** Hlavní API: vezme všechny chunky a vrátí okna pro AI. */
    selectBestChunks(all: SelChunk[], opts: SelectOpts): SelChunk[][] {
        const {
            perFileCap,
            globalCap,
            windowSize,
            coalesceMaxChars = Number(process.env.AI_COALESCE_MAX_CHARS ?? 900),
            coalesceMinChars = Number(process.env.AI_COALESCE_MIN_CHARS ?? 350),
        } = opts;

        // 0) Normalizace textu + základní filtr
        let normed: NormalizedChunk[] = all
            .map((c) => ({
                id: String(c.id),
                fileId: c.fileId ? String(c.fileId) : undefined,
                index: typeof c.index === 'number' ? c.index : undefined,
                text: this.normalizeText(String(c.text ?? '')),
            }))
            .filter((c) => c.text.length > 60);

        if (!normed.length) return [];

        // 0.5) Koalescence sousedů (stejné fileId, index n→n+1)
        normed = this.coalesceAdjacent(normed, coalesceMaxChars, coalesceMinChars);

        // 1) Skórování + fingerprint
        const scored = normed.map((c) => ({
            ...c,
            score: this.scoreChunk(c.text),
            fp: this.fingerprint(c.text),
        }));

        // 2) Dedup podle fingerprintu
        const seenFp = new Set<string>();
        const unique = scored.filter((c) => {
            if (seenFp.has(c.fp)) return false;
            seenFp.add(c.fp);
            return true;
        });
        if (!unique.length) return [];

        // 3) Stratifikace: top-K z každého souboru
        const byFile = new Map<string, typeof unique>();
        for (const c of unique) {
            const key = c.fileId || '_nofile';
            if (!byFile.has(key)) byFile.set(key, []);
            byFile.get(key)!.push(c);
        }
        for (const arr of byFile.values()) arr.sort((a, b) => b.score - a.score);

        const stratified: typeof unique = [];
        for (const arr of byFile.values()) stratified.push(...arr.slice(0, perFileCap));

        // 4) Doplnění do globalCap z celkového žebříčku (kontrola dle fp, ne includes)
        const inStrat = new Set<string>(stratified.map((c) => c.fp));
        const globalSorted = [...unique].sort((a, b) => b.score - a.score);
        for (const c of globalSorted) {
            if (stratified.length >= globalCap) break;
            if (!inStrat.has(c.fp)) {
                stratified.push(c);
                inStrat.add(c.fp);
            }
        }

        // 5) Rozdělení do oken
        stratified.sort((a, b) => b.score - a.score);

        const windows: SelChunk[][] = [];
        for (let i = 0; i < stratified.length; i += windowSize) {
            const slice = stratified.slice(i, i + windowSize).map((c) => ({
                id: c.id,
                text: c.text,
                fileId: c.fileId, // volitelné
            }));
            windows.push(slice);
        }

        this.logger.log(
            `Selected ${stratified.length}/${normed.length} chunks → ${windows.length} windows (w=${windowSize}).`,
        );
        return windows;
    }

    // ================== Heuristiky a utility ==================

    /** Koalescence sousedů v rámci stejného souboru. */
    private coalesceAdjacent(arr: NormalizedChunk[], maxChars: number, minChars: number): NormalizedChunk[] {
        const sortable = [...arr].sort((a, b) => {
            const fa = a.fileId ?? '';
            const fb = b.fileId ?? '';
            if (fa !== fb) return fa < fb ? -1 : 1;
            const ia = a.index ?? Number.MAX_SAFE_INTEGER;
            const ib = b.index ?? Number.MAX_SAFE_INTEGER;
            return ia - ib;
        });

        const out: NormalizedChunk[] = [];
        let buf: NormalizedChunk | null = null;
        const flush = () => { if (buf) out.push(buf); buf = null; };

        for (const c of sortable) {
            if (!buf) { buf = { ...c }; continue; }

            const consecutive =
                buf.fileId === c.fileId &&
                typeof buf.index === 'number' &&
                typeof c.index === 'number' &&
                c.index === (buf.index as number) + 1;

            const shortBuf = buf.text.length < minChars;
            const canGrow = buf.text.length + 1 + c.text.length <= maxChars;

            if (consecutive && (shortBuf || canGrow)) {
                buf.text = `${buf.text} ${c.text}`;
                buf.index = c.index;
                continue;
            }
            flush();
            buf = { ...c };
        }
        flush();
        return out;
    }

    /** Skóre „výživnosti“ chunku. */
    private scoreChunk(t: string): number {
        const len = t.length;
        let s = 0;

        // délka – preferujeme cca 600–1600 znaků
        if (len >= 300 && len <= 2000) s += 2.5;
        if (len >= 600 && len <= 1600) s += 2.5;

        const low = t.toLowerCase();

        // pozitivní nápovědy
        let pos = 0;
        for (const h of this.POSITIVE_HINTS) if (low.includes(h)) pos++;
        s += Math.min(4, pos * 0.8);

        // struktura (nadpisy/odrážky/číslování)
        if (/^#{1,3}\s|\b\d+\.\s|[-•]\s/.test(t)) s += 1.2;

        // čísla/rovnice – mírně plus
        const nums = (t.match(/\d+/g) || []).length;
        if (nums > 0 && nums < 30) s += 1.0;

        // „unikátnost“ znakového spektra – méně boilerplate
        const uniqRatio = new Set(t).size / Math.max(1, len);
        if (uniqRatio > 0.15) s += 0.8;

        // penalizace boilerplate
        for (const h of this.NEGATIVE_HINTS) if (low.includes(h)) s -= 1.2;

        // moc odkazů → balast
        const links = (t.match(/https?:\/\/|www\./gi) || []).length;
        if (links > 2) s -= 1.5;

        // moc „technické“ interpunkce
        const punct = (t.match(/[{}<>_=]{2,}/g) || []).length;
        if (punct > 5) s -= 1.0;

        return s;
    }

    /** Fingerprint (pro dedup) – FNV-1a nad normalizovaným prefixem. */
    private fingerprint(t: string): string {
        const n = this.normalizeForFp(t).slice(0, 300);
        let h = 2166136261 >>> 0; // FNV-1a offset basis
        for (let i = 0; i < n.length; i++) {
            h ^= n.charCodeAt(i);
            h = (h * 16777619) >>> 0;
        }
        return h.toString(16);
    }

    /** Normalizace textu do jedné mezery + trim. */
    private normalizeText(s: string): string {
        return s.replace(/\s+/g, ' ').trim();
    }

    /** Normalizace pro fingerprint: lower, jedna mezera, bez „exotických“ znaků. */
    private normalizeForFp(s: string): string {
        return s
            .toLowerCase()
            .replace(/\s+/g, ' ')
            .replace(/[^\p{L}\p{N}\s\.,;:()%-]/gu, '');
    }
}
