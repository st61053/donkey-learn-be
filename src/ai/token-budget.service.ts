import { Injectable } from '@nestjs/common';

export type BudgetInputs = {
    model: string;
    contextLimit: number;       // např. 4096 / 6144 / 8192
    maxOutputTokens: number;    // např. 600 / 900 / 1200
    schemaOverhead: number;     // např. 200
    safety: number;             // např. 256
    systemMsg: string;          // krátký system
    headerMsg: string;          // instrukce bez samotných úryvků
    lines: string[];            // už ořezané „c:id | text…“ řádky
};

export type WindowEstimate = {
    index: number;
    lineCount: number;
    approxPromptTokens: number;       // system + header + body
    promptBudget: number;             // contextLimit - schemaOverhead - safety - maxOutputTokens
    headroom: number;                 // promptBudget - approxPromptTokens
    willFit: boolean;
};

export type PlanSummary = {
    ok: true;
    model: string;
    totals: {
        files: number;
        chunksFound: number;
        chunksSelected: number;
        windows: number;
    };
    config: {
        contextLimit: number;
        maxOutputTokens: number;
        schemaOverhead: number;
        safety: number;
        promptBudget: number;
        perWindowTarget: number;
        windowSize: number;
        trimChars: number;
    };
    windows: WindowEstimate[];
    fit: {
        fitting: number;
        notFitting: number;
        fitRatio: number; // 0..1
    };
    recommendations: string[];
    debug?: {
        // volitelně čísla pro ladění
        baseTokens: number; // system + header
        avgBodyTokens: number;
    };
};

@Injectable()
export class TokenBudgetService {
    // velmi hrubý, ale stabilní odhad (cca znak/4 = token)
    roughTokens(s: string): number {
        return Math.ceil(String(s || '').replace(/\s+/g, ' ').trim().length / 4);
    }

    /**
     * Vrátí detailní plán a doporučení pro zadané vstupy.
     */
    buildDetailedPlan(args: {
        model: string;
        contextLimit: number;
        maxOutputTokens: number;
        schemaOverhead: number;
        safety: number;
        systemMsg: string;
        headerMsg: string;
        windowsLines: string[][];
        perWindowTarget: number;
        windowSize: number;
        trimChars: number;
        totals: { files: number; chunksFound: number; chunksSelected: number };
    }): PlanSummary {
        const {
            model, contextLimit, maxOutputTokens, schemaOverhead, safety,
            systemMsg, headerMsg, windowsLines, perWindowTarget, windowSize, trimChars, totals,
        } = args;

        const baseTokens = this.roughTokens(systemMsg) + this.roughTokens(headerMsg);
        const promptBudget = Math.max(256, contextLimit - schemaOverhead - safety - maxOutputTokens);

        const windows: WindowEstimate[] = windowsLines.map((lines, i) => {
            const bodyTokens = this.roughTokens(lines.join('\n'));
            const approxPromptTokens = baseTokens + bodyTokens;
            const headroom = promptBudget - approxPromptTokens;
            return {
                index: i + 1,
                lineCount: lines.length,
                approxPromptTokens,
                promptBudget,
                headroom,
                willFit: headroom >= 0,
            };
        });

        const fitting = windows.filter(w => w.willFit).length;
        const notFitting = windows.length - fitting;
        const fitRatio = windows.length ? fitting / windows.length : 1;

        const recs: string[] = [];

        if (fitRatio < 1) {
            // najdi nejhorší okno
            const worst = windows.reduce((a, b) => (a.headroom < b.headroom ? a : b), windows[0]);
            recs.push(`Některá okna se nevejdou (např. okno #${worst.index} přesahuje o ${Math.abs(worst.headroom)} tokenů).`);
        }

        if (fitRatio < 0.9) recs.push('Snižte windowSize (např. -1 nebo -2) nebo zkraťte trimChars (např. -200).');
        if (maxOutputTokens > 800 && fitRatio < 1) recs.push('Zvažte snížení maxOutputTokens (např. -200), uvolní to místo pro vstup.');
        if (schemaOverhead > 250) recs.push('Zkraťte schéma nástroje/JSON (schemaOverhead).');
        if (safety > 256) recs.push('Snižte safety rezervu na ~256.');

        // jemnější doporučení: odhad průměrného těla
        const avgBody = windowsLines.length
            ? Math.round(windowsLines.map(l => this.roughTokens(l.join('\n'))).reduce((a, b) => a + b, 0) / windowsLines.length)
            : 0;

        const summary: PlanSummary = {
            ok: true,
            model,
            totals: {
                files: totals.files,
                chunksFound: totals.chunksFound,
                chunksSelected: totals.chunksSelected,
                windows: windowsLines.length,
            },
            config: {
                contextLimit,
                maxOutputTokens,
                schemaOverhead,
                safety,
                promptBudget,
                perWindowTarget,
                windowSize,
                trimChars,
            },
            windows,
            fit: { fitting, notFitting, fitRatio: Number(fitRatio.toFixed(3)) },
            recommendations: recs.length ? recs : ['Konfigurace vypadá v pořádku.'],
            debug: {
                baseTokens,
                avgBodyTokens: avgBody,
            },
        };

        return summary;
    }

    // Back-compat: jednoduchý odhad tokenů pro pole řádků + volitelnou hlavičku
    estimatePromptSize(lines: string[], header: string = ''): number {
        const head = this.roughTokens(header);
        let body = 0;
        for (const s of lines || []) body += this.roughTokens(s);
        // přibližně: system zpráva bývá krátká; pokud chceš, přičti fixní rezervu
        return head + body;
    }
}
