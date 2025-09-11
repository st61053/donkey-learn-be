// src/ai/ai.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { AiRequestDto } from './dto/ai-request.dto';
import { AiResponseDto, AiQuestion } from './dto/ai-response.dto';
import OpenAI from 'openai';

type LocalReasoningEffort = 'low' | 'medium' | 'high';
type LocalReasoning = { effort?: LocalReasoningEffort };

@Injectable()
export class AiService {
    private readonly logger = new Logger(AiService.name);
    private readonly client: OpenAI;

    private readonly MAX_QS_PER_CALL = 24;
    private readonly MIN_QUESTION_LEN = 8;
    private readonly DEBUG = (process.env.AI_DEBUG_LOG ?? 'false') === 'true';

    constructor() {
        this.client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    }

    // ========================================================================
    // Public: generateQuestions (primárně Responses API, fallback Chat API)
    // ========================================================================
    async generateQuestions(dto: AiRequestDto, _socketId?: string): Promise<AiResponseDto> {
        const { model, chunks, mix, instruction } = dto;

        const allowedKinds = Object.entries(mix ?? {})
            .filter(([_, v]) => Number(v) > 0)
            .map(([k]) => String(k).toLowerCase().trim() as 'mcq' | 'msq' | 'tf' | 'cloze' | 'short' | 'match' | 'order');

        if (allowedKinds.length === 0) allowedKinds.push('mcq');

        const perCallTarget =
            (Object.values(mix ?? {}).reduce((a: number, b: number) => a + Number(b || 0), 0)) || 8;
        const boundedTarget = Math.min(perCallTarget, this.MAX_QS_PER_CALL);

        // Kompaktní řádky
        const MAX_CHARS = Number(process.env.AI_CHUNK_TRIM_CHARS ?? 1200);
        const rawLines = (chunks || []).map((c) => {
            const tx = String(c.text ?? '').slice(0, MAX_CHARS).replace(/\s+/g, ' ').trim();
            return `c:${c.id}${c.fileId ? ` f:${c.fileId}` : ''} | ${tx}`;
        });

        const systemMsg =
            'Jsi přísný zkoušející. Tvoř otázky výhradně z poskytnutých úryvků (c:id f:fileId | text). Nehalucinuj.';

        const headerOnly = [
            instruction || 'Vytvoř smysluplné, fakticky přesné otázky.',
            `Mix (horní limity, můžeš vytvořit méně): ${JSON.stringify(mix ?? {})}`,
            `GENERUJ POUZE tyto typy: ${allowedKinds.join(', ')}. Jiné typy NEVRACEJ.`,
            'U každé otázky vyplň s.c = ID úryvku (po "c:" v řádku) a s.f = fileId (po "f:" v řádku).',
            `Maximálně ${boundedTarget} otázek. Použij různé typy dle mixu.`,
            `Preferuj koncepty, které se v úryvcích explicitně definují/vysvětlují; ignoruj boilerplate a metadata.`,
            `NEVKLÁDEJ do textu otázek ani možností identifikátory zdrojů (např. "c:...", "f:..."), názvy souborů, ani fráze typu "Podle úryvku", "Dle textu", "Viz úryvek".`,
            `Identifikátory zdrojů zapisuj POUZE do objektu s: { s: { c: <chunkId>, f: <fileId> } }.`,
            `Formuluj otázku soběstačně (bez "Podle úryvku …").`,
            `Úryvky následují po této hlavičce.`,
        ].join('\n');

        const desiredMaxOut = Number(process.env.OPENAI_MAX_OUTPUT_TOKENS ?? 800);

        // Budget cap (sjednoceno s preflightem)
        const cap = this.buildPromptWithCap({
            model,
            systemMsg,
            headerMsg: headerOnly,
            lines: rawLines,
            maxCompletion: desiredMaxOut,
            useTools: false,
            extraMargin: 700, // víc prostoru pro výstup, aby se JSON nedořezal
        });

        if (this.DEBUG) {
            this.logger.log(
                `AI budget RESP: ctx=${cap.metrics.contextLimit} promptBudget=${cap.metrics.promptBudget} ` +
                `base=${cap.metrics.baseTokens} in=${rawLines.length} -> used=${cap.cappedLines.length} ` +
                `approxPrompt=${cap.metrics.approxPromptTokens} headroom=${cap.metrics.headroom}`,
            );
        }

        const userMsg = [
            'VRAŤ POUZE JSON podle přiloženého schématu. Žádný volný text.',
            'Začni přesně {"qs":[ a dokonči platný JSON s uzavíracími ]}.',
            'Vyplň VŠECHNA níže uvedená pole u každé otázky. Pro typy, kde pole nedává smysl, použij neutrální hodnoty: ' +
            'o, ci, l, rm, g = []; rb = false; rs = ""; s = {}.',
            headerOnly,
            'Úryvky:',
            cap.cappedLines.join('\n'),
        ].join('\n\n');

        // === Responses API (Structured Outputs) — primární cesta ===
        const effectiveModel = model;

        try {
            const minQ = this.MIN_QUESTION_LEN;

            // Strict ploché schéma bez oneOf; všechna pole required; s je prázdné {} s additionalProperties:false
            const schemaFormat = {
                type: 'json_schema',
                name: 'rq',
                strict: true,
                schema: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['qs'],
                    properties: {
                        qs: {
                            type: 'array',
                            minItems: 1,
                            items: {
                                type: 'object',
                                additionalProperties: false,
                                properties: {
                                    k: { type: 'string', enum: ['mcq', 'msq', 'tf', 'cloze', 'short', 'match', 'order'] },
                                    t: { type: 'string', minLength: minQ },
                                    o: { type: 'array', items: { type: 'string' } },
                                    ci: { type: 'array', items: { type: 'integer', minimum: 0 } },
                                    rb: { type: 'boolean' },
                                    rs: { type: 'string' },
                                    l: { type: 'array', items: { type: 'string' } },
                                    rm: { type: 'array', items: { type: 'string' } },
                                    g: { type: 'array', items: { type: 'string' } },
                                    s: {
                                        type: 'object',
                                        additionalProperties: false,
                                        properties: { c: { type: 'string' }, f: { type: 'string' } },
                                        required: ['c', 'f']
                                    }
                                },
                                required: ['k', 't', 'o', 'ci', 'rb', 'rs', 'l', 'rm', 'g', 's']
                            }
                        }
                    }
                }
            } as const;

            // Sniž reasoning tokens podle env (AI_REASONING_EFFORT=low|medium|high)
            const effortEnv = String(process.env.AI_REASONING_EFFORT ?? 'low').toLowerCase() as LocalReasoningEffort;
            const reasoning: LocalReasoning = { effort: effortEnv };

            const resp = await this.client.responses.create({
                model: effectiveModel,
                input: [
                    { role: 'system', content: systemMsg },
                    { role: 'user', content: userMsg },
                ],
                max_output_tokens: desiredMaxOut,
                reasoning: reasoning as any,
                text: { format: schemaFormat },
            });

            this.logResponsesShape(resp, 'responses');

            // ✅ Structured Outputs / text → vytěž qs
            const qsRaw = this.extractQsFromResponses(resp);
            if (qsRaw?.length) {
                const valid = this.validateQuestions(qsRaw);
                const filtered = this.filterAndCapByMix(valid, mix);
                if (filtered.length > 0) {
                    this.logger.log(`Generated ${filtered.length} questions (responses)`);
                    this.dumpQuestionsToFile(filtered, effectiveModel, 'responses');
                    return { model: effectiveModel, questions: filtered };
                }
            }

            // Pro debug ulož strom, pokud nic nevyšlo
            this.dumpResponsesRaw(resp, '', 'responses-no-qs');
        } catch (e) {
            this.logger.error(`Responses API call failed: ${(e as Error)?.message}`);
        }

        // === Fallback: Chat Completions ===
        const chatOut = await this.generateViaChatCompletions({
            model: effectiveModel,
            userMsg,
            systemMsg,
            maxOut: desiredMaxOut,
        });

        if (chatOut?.length) {
            this.logger.log(`Generated ${chatOut.length} questions (chat-fallback)`);
            this.dumpQuestionsToFile(chatOut, effectiveModel, 'chat-fallback');
            return { model: effectiveModel, questions: chatOut };
        }

        this.logger.log('Generated 0 questions');
        return { model: effectiveModel, questions: [] };
    }

    // ========================================================================
    // Chat Completions fallback (JSON-only → tools)
    // ========================================================================
    private async generateViaChatCompletions(args: {
        model: string;
        systemMsg: string;
        userMsg: string;
        maxOut: number;
    }): Promise<AiQuestion[] | null> {
        const { model, systemMsg, userMsg } = args;

        const allowJsonMode = (process.env.AI_JSON_MODE ?? 'true') === 'true';
        const canUseResponseFormat = allowJsonMode && !/gpt-5-mini/i.test(model);

        // 1) JSON-only pokus
        const jsonOnlyMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
            { role: 'system', content: systemMsg },
            {
                role: 'user',
                content: [
                    'VRAŤ POUZE PLATNÝ JSON BEZ PROSE A BEZ CODE FENCE.',
                    `Vyplň VŠECHNA níže uvedená pole u každé otázky.
                    - Pro typy, kde pole nedává smysl, použij neutrální hodnoty:
                      o, ci, l, rm, g = [] (prázdné pole)
                      rb = false
                      rs = "" (prázdný řetězec)
                      s = {} (prázdný objekt)`,
                    'Kořenový objekt musí být přesně {"qs":[...]}',
                    'Každá otázka musí mít vlastnost "k" a "t". Ostatní pole přidej jen pokud dávají smysl.',
                    'Nepiš nic jiného než JSON.',
                    userMsg,
                ].join('\n\n'),
            },
        ];

        let resp3: OpenAI.Chat.Completions.ChatCompletion | null = null;
        try {
            const body: any = { model, messages: jsonOnlyMessages };
            if (canUseResponseFormat) body.response_format = { type: 'json_object' };
            resp3 = await this.chatCreateCompat(body);
        } catch (e) {
            this.logger.error(`Chat fallback (json-only) failed: ${(e as Error)?.message}`);
            resp3 = null;
        }

        if (resp3) {
            this.logAiShape(resp3, 'json-only');
            const raw = resp3.choices?.[0]?.message?.content ?? '';
            if (!raw) this.dumpAiRaw(resp3, raw, 'chat-json-only-empty');
            const parsed3 = this.safeParseQuestions(raw);
            const valid3 = this.filterAndCapByMix(parsed3);
            if (valid3.length > 0) {
                this.dumpQuestionsToFile(valid3, model, 'chat-json-only');
                return valid3;
            }
        }

        // 2) Tools (function-calling) pokus
        const rqTool: OpenAI.Chat.Completions.ChatCompletionTool = {
            type: 'function',
            function: {
                name: 'rq',
                description: 'Vrať otázky v JSONu. Zavolej jednou a nic jiného nepiš.',
                parameters: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['qs'],
                    properties: {
                        qs: {
                            type: 'array',
                            minItems: 1,
                            items: {
                                type: 'object',
                                // povinné jen k,t; ostatní volitelné
                                required: ['k', 't'],
                                properties: {
                                    k: { type: 'string' },
                                    t: { type: 'string' },
                                    o: { type: 'array', items: { type: 'string' } },
                                    ci: { type: 'array', items: { type: 'integer', minimum: 0 } },
                                    r: { type: 'string' },
                                    g: { type: 'array', items: { type: 'string' } },
                                    l: { type: 'array', items: { type: 'string' } },
                                    s: { type: 'object' },
                                },
                                additionalProperties: true,
                            },
                        },
                    },
                },
            },
        };

        const messagesTools: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
            { role: 'system', content: systemMsg },
            {
                role: 'user',
                content: [
                    'Použij funkci `rq` a vrať otázky v JSONu jako argument funkce.',
                    'Nepiš žádný volný text ani code fences. Zavolej funkci přesně jednou.',
                    userMsg,
                ].join('\n\n'),
            },
        ];

        let resp: OpenAI.Chat.Completions.ChatCompletion | null = null;
        try {
            resp = await this.chatCreateCompat({
                model,
                messages: messagesTools,
                tools: [rqTool],
                tool_choice: { type: 'function', function: { name: 'rq' } } as any,
            });
        } catch (e) {
            this.logger.error(`Chat fallback (tools) failed: ${(e as Error)?.message}`);
            resp = null;
        }

        if (!resp) return null;

        this.logAiShape(resp, 'tools');
        const parsed = this.extractFromToolOrContent(resp);
        const valid = this.filterAndCapByMix(parsed);
        if (valid.length > 0) {
            this.dumpQuestionsToFile(valid, model, 'chat-tools');
            return valid;
        }

        this.dumpAiRaw(resp, resp.choices?.[0]?.message?.content ?? '', 'chat-tools-empty');
        return null;
    }

    // ========================================================================
    // Chat API kompatibilita (max_* tokens, bez teploty pokud nepovoleno)
    // ========================================================================
    private async chatCreateCompat(
        body: Omit<OpenAI.Chat.Completions.ChatCompletionCreateParams, 'model'> & { model: string },
    ) {
        const desired = Number(process.env.OPENAI_MAX_OUTPUT_TOKENS ?? 800);
        const base: any = { ...body };

        const allowTemp = (process.env.AI_ALLOW_TEMPERATURE ?? 'false') === 'true';
        if (!allowTemp) delete base.temperature;

        base.max_completion_tokens = desired;
        delete base.max_tokens;

        try {
            return await this.client.chat.completions.create(base);
        } catch (e: any) {
            const msg = String(e?.message ?? '');

            if (msg.includes('Unsupported parameter') && msg.includes('max_completion_tokens')) {
                const fallback = { ...base };
                delete fallback.max_completion_tokens;
                fallback.max_tokens = desired;
                this.logger.warn('AI: retrying with max_tokens (instead of max_completion_tokens)');
                return await this.client.chat.completions.create(fallback);
            }
            if (msg.includes('Unsupported parameter') && msg.includes('max_tokens')) {
                const alt = { ...base };
                delete alt.max_tokens;
                alt.max_completion_tokens = desired;
                this.logger.warn('AI: retrying with max_completion_tokens (instead of max_tokens)');
                return await this.client.chat.completions.create(alt);
            }
            if (msg.includes("Unsupported value: 'temperature'")) {
                const noTemp = { ...base };
                delete noTemp.temperature;
                this.logger.warn('AI: retrying without temperature parameter');
                return await this.client.chat.completions.create(noTemp);
            }

            throw e;
        }
    }

    // ========================================================================
    // Parsers & normalizace
    // ========================================================================
    /** Structured Outputs: vytáhne {qs:[...]} z Responses API. */
    private extractQsFromResponses(resp: any): any[] {
        // 1) nový convenience field
        if (Array.isArray(resp?.output_parsed) && resp.output_parsed.length) {
            const first = resp.output_parsed[0];
            if (first?.qs && Array.isArray(first.qs)) return first.qs;
        }
        // 2) obecný strom: output -> content[].parsed
        try {
            const out = resp?.output;
            if (Array.isArray(out)) {
                for (const item of out) {
                    const content = (item as any)?.content;
                    if (Array.isArray(content)) {
                        for (const node of content) {
                            const parsed = (node as any)?.parsed;
                            if (parsed?.qs && Array.isArray(parsed.qs)) return parsed.qs;
                        }
                    }
                }
            }
        } catch { /* ignore */ }
        // 3) fallback: zkus text a rozparsuj
        const txt = this.pickResponseText(resp);
        if (txt) {
            // standardní tolerantní parser
            const qs = this.safeParseQuestions(txt);
            if (qs.length) return qs;

            // uříznutý JSON → vytěž kompletně uzavřené objekty uvnitř "qs"
            const partial = this.extractPartialQsFromText(txt);
            if (partial.length) return partial;
        }
        return [];
    }

    /** Z uříznutého output_text vytáhne kompletní objekty v poli "qs". */
    private extractPartialQsFromText(text: string): any[] {
        if (!text) return [];
        const startKey = '"qs"';
        const idx = text.indexOf(startKey);
        if (idx < 0) return [];
        const arrStart = text.indexOf('[', idx);
        if (arrStart < 0) return [];

        const out: any[] = [];
        let i = arrStart + 1;
        const n = text.length;

        const skipWs = () => { while (i < n && /[\s,]/.test(text[i])) i++; };

        const takeObject = (): string | null => {
            skipWs();
            if (i >= n || text[i] !== '{') return null;
            let depth = 0;
            let inStr = false;
            let esc = false;
            const start = i;
            while (i < n) {
                const ch = text[i++];
                if (inStr) {
                    if (esc) { esc = false; continue; }
                    if (ch === '\\') { esc = true; continue; }
                    if (ch === '"') inStr = false;
                } else {
                    if (ch === '"') inStr = true;
                    else if (ch === '{') depth++;
                    else if (ch === '}') {
                        depth--;
                        if (depth === 0) {
                            return text.slice(start, i);
                        }
                    } else if (ch === ']') {
                        return null;
                    }
                }
            }
            return null;
        };

        while (i < n) {
            const objStr = takeObject();
            if (!objStr) break;
            const repaired = objStr.replace(/,\s*([}\]])/g, '$1');
            try {
                const parsed = JSON.parse(repaired);
                out.push(parsed);
            } catch {
                break;
            }
            skipWs();
            if (text[i] === ',') i++;
        }
        return out;
    }

    /** Primárně tool_calls[0].function.arguments; jinak content (Chat API fallback). */
    private extractFromToolOrContent(resp: OpenAI.Chat.Completions.ChatCompletion): any[] {
        const choice = resp.choices?.[0];
        const msg = choice?.message;
        const tcs = msg?.tool_calls;

        if (Array.isArray(tcs) && tcs.length > 0) {
            for (const call of tcs) {
                if ((call as any).type === 'function' && (call as any).function?.arguments) {
                    try {
                        const obj = JSON.parse((call as any).function.arguments as string);
                        if (obj?.qs && Array.isArray(obj.qs)) return obj.qs;
                        if (Array.isArray(obj)) return obj;
                        if (obj?.questions && Array.isArray(obj.questions)) return obj.questions;
                    } catch { /* ignore */ }
                }
            }
        }

        const raw = msg?.content ?? '';
        return this.safeParseQuestions(raw);
    }

    private safeParseQuestions(str: string): any[] {
        if (!str) return [];
        const tryParse = (s: string) => { try { return JSON.parse(s); } catch { return null; } };

        const d = tryParse(str);
        if (d?.qs && Array.isArray(d.qs)) return d.qs;
        if (Array.isArray(d)) return d;
        if (d?.questions && Array.isArray(d.questions)) return d.questions;

        const fence = str.match(/```json\s*([\s\S]*?)\s*```/i) || str.match(/```\s*([\s\S]*?)\s*```/i);
        if (fence?.[1]) {
            const clean = this.sanitizeJson(fence[1]);
            const p = tryParse(clean);
            if (p?.qs && Array.isArray(p.qs)) return p.qs;
            if (Array.isArray(p)) return p;
            if (p?.questions && Array.isArray(p.questions)) return p.questions;
        }

        const arrMatch = str.match(/\[\s*{[\s\S]*}\s*\]/);
        if (arrMatch?.[0]) {
            const repaired = this.sanitizeJson(arrMatch[0]);
            const arr = tryParse(repaired);
            if (Array.isArray(arr)) return arr;
        }

        const qsIdx = str.indexOf('"qs"');
        if (qsIdx >= 0) {
            const start = str.lastIndexOf('{', qsIdx);
            const end = str.indexOf('}', qsIdx);
            if (start >= 0 && end > start) {
                const candidate = this.sanitizeJson(str.slice(start, end + 1));
                const candParsed = tryParse(candidate);
                if (candParsed?.qs && Array.isArray(candParsed.qs)) return candParsed.qs;
            }
        }

        return [];
    }

    private sanitizeJson(s: string): string {
        let x = s.replace(/^\uFEFF/, '');
        x = x.replace(/```json|```/g, '');
        x = x.replace(/,\s*([}\]])/g, '$1');
        x = x.replace(/'([^']*)'/g, (_m, g1) => `"${g1.replace(/"/g, '\\"')}"`);
        return x;
    }

    private normalizeKind(
        input: any,
    ): 'mcq' | 'msq' | 'tf' | 'cloze' | 'short' | 'match' | 'order' | null {
        if (typeof input === 'string') {
            const s = input.toLowerCase().trim();
            if (['mcq', 'single', 'single_choice', 'singleanswer'].includes(s)) return 'mcq';
            if (['msq', 'multiple', 'multi', 'multiple_choice', 'multipleanswer'].includes(s)) return 'msq';
            if (['tf', 'truefalse', 'true_false', 'boolean'].includes(s)) return 'tf';
            if (['cloze', 'gap', 'fill', 'fill_in', 'fillintheblank'].includes(s)) return 'cloze';
            if (['short', 'short_answer', 'free'].includes(s)) return 'short';
            if (['match', 'pair', 'pairing'].includes(s)) return 'match';
            if (['order', 'sequence', 'sort'].includes(s)) return 'order';
        }
        if (typeof input === 'number') {
            const m: Record<number, any> = { 1: 'mcq', 2: 'msq', 3: 'tf', 4: 'cloze', 5: 'short', 6: 'match', 7: 'order' };
            return m[input] ?? null;
        }
        return null;
    }

    private validateQuestions(qs: any[]): AiQuestion[] {
        if (!Array.isArray(qs)) return [];
        const norm = qs
            .filter(Boolean)
            .map((q) => {
                const kind = this.normalizeKind((q as any).k);
                const t = String((q as any).t ?? '').trim();
                if (!kind || t.length < this.MIN_QUESTION_LEN) return null;

                switch (kind) {
                    case 'mcq':
                    case 'msq': {
                        const o = Array.isArray((q as any).o) ? (q as any).o.map(String).filter(Boolean) : [];
                        let ci: number[] = [];
                        if (Array.isArray((q as any).ci)) {
                            ci = (q as any).ci.map((n: any) => Number(n)).filter(Number.isFinite);
                        } else if ((q as any).ci !== undefined) {
                            const n = Number((q as any).ci);
                            if (Number.isFinite(n)) ci = [n];
                        }
                        if (o.length < 2 || ci.length < 1 || ci.some((i: number) => i < 0 || i >= o.length)) return null;
                        return { k: kind, t, o, ci, s: (q as any).s } as AiQuestion;
                    }

                    case 'tf': {
                        // podpora starého 'r' i nového 'rb'
                        const r =
                            typeof (q as any).r === 'boolean'
                                ? (q as any).r
                                : typeof (q as any).rb === 'boolean'
                                    ? (q as any).rb
                                    : (String((q as any).r).toLowerCase() === 'true');
                        return { k: kind, t, r, s: (q as any).s } as AiQuestion;
                    }

                    case 'cloze': {
                        const g = Array.isArray((q as any).g) ? (q as any).g.map(String).filter(Boolean) : [];
                        if (!g.length) return null;
                        return { k: kind, t, g, s: (q as any).s } as AiQuestion;
                    }

                    case 'short': {
                        // podpora starého 'r' i nového 'rs'
                        const r0 = (q as any).r;
                        const rs = String((q as any).rs ?? '').trim();
                        const r = typeof r0 === 'string' && r0.trim() ? r0.trim() : rs;
                        if (!r) return null;
                        return { k: kind, t, r, s: (q as any).s } as AiQuestion;
                    }

                    case 'match': {
                        const l = Array.isArray((q as any).l) ? (q as any).l.map(String).filter(Boolean) : [];
                        const rlist = Array.isArray((q as any).r) ? (q as any).r : Array.isArray((q as any).rm) ? (q as any).rm : [];
                        const r = rlist.map(String).filter(Boolean);
                        if (l.length < 2 || r.length < 2) return null;
                        return { k: kind, t, l, r, s: (q as any).s } as AiQuestion;
                    }

                    case 'order': {
                        const o = Array.isArray((q as any).o) ? (q as any).o.map(String).filter(Boolean) : [];
                        if (o.length < 2) return null;
                        return { k: kind, t, o, s: (q as any).s } as AiQuestion;
                    }

                    default:
                        return null;
                }
            })
            .filter(Boolean) as AiQuestion[];

        // dedup
        const seen = new Set<string>();
        const out: AiQuestion[] = [];
        for (const q of norm) {
            const key = `${q.k}|${q.t}`;
            if (!seen.has(key)) {
                seen.add(key);
                out.push(q);
            }
        }
        return out;
    }

    // ========================================================================
    // Budgets
    // ========================================================================
    private getContextLimit(_model: string) {
        return Number(process.env.AI_CONTEXT_LIMIT ?? 4096);
    }
    private getSafety() {
        return Number(process.env.AI_SAFETY_TOKENS ?? 256);
    }
    private getSchemaOverhead(useTools: boolean) {
        const envTools = Number(process.env.AI_SCHEMA_OVERHEAD ?? 0);
        const envJson = Number(process.env.AI_SCHEMA_OVERHEAD_JSON ?? 0);
        if (useTools) return envTools > 0 ? envTools : 900; // tools schema overhead
        return envJson > 0 ? envJson : 180;                 // json-only/Responses overhead
    }
    private roughTokens(s: string) {
        return Math.ceil(String(s || '').replace(/\s+/g, ' ').trim().length / 4);
    }

    private buildPromptWithCap(args: {
        model: string;
        systemMsg: string;
        headerMsg: string;
        lines: string[];
        maxCompletion: number;
        useTools: boolean;
        extraMargin?: number;
    }) {
        const { model, systemMsg, headerMsg, lines, maxCompletion, useTools, extraMargin = 120 } = args;

        const ctx = this.getContextLimit(model);
        const safety = this.getSafety();
        const schemaOverhead = this.getSchemaOverhead(useTools);

        const base = this.roughTokens(systemMsg) + this.roughTokens(headerMsg);
        const promptBudget = Math.max(256, ctx - schemaOverhead - safety - maxCompletion);

        const capped: string[] = [];
        let acc = base;

        for (const ln of lines) {
            const tk = this.roughTokens(ln + '\n');
            if (acc + tk > (promptBudget - extraMargin)) break;
            capped.push(ln);
            acc += tk;
        }

        if (capped.length === 0 && lines.length > 0) {
            const room = Math.max(80, (promptBudget - base - extraMargin) * 4);
            capped.push(lines[0].slice(0, room));
            acc = base + this.roughTokens(capped[0] + '\n');
        }

        return {
            cappedLines: capped,
            metrics: {
                contextLimit: ctx,
                schemaOverhead,
                safety,
                maxCompletion,
                promptBudget,
                baseTokens: base,
                approxPromptTokens: acc,
                headroom: promptBudget - acc,
            },
        };
    }

    // ========================================================================
    // Debug / Dump helpers
    // ========================================================================
    /** Opatrně vybere text z Responses API výstupu bez závislosti na TS typech SDK. */
    private pickResponseText(resp: any): string | null {
        if (resp && typeof resp.output_text === 'string' && resp.output_text.length) {
            return resp.output_text;
        }
        try {
            const out = resp?.output;
            if (Array.isArray(out)) {
                for (const item of out) {
                    const c = (item as any)?.content;
                    if (Array.isArray(c)) {
                        for (const node of c) {
                            if (node?.type === 'output_text' && typeof node?.text === 'string' && node.text.length) {
                                return node.text;
                            }
                            if (node?.type === 'text' && typeof node?.text === 'string' && node.text.length) {
                                return node.text;
                            }
                        }
                    }
                }
            }
        } catch { /* ignore */ }
        return null;
    }

    private logAiShape(resp: OpenAI.Chat.Completions.ChatCompletion, tag: string) {
        const ch = resp.choices?.[0];
        const msg = ch?.message;
        const tcs = msg?.tool_calls;
        const hasTools = Array.isArray(tcs) && tcs.length > 0;
        const types = hasTools ? tcs.map((t: any) => t?.type ?? 'unknown').join(',') : '-';
        const contentLen = (msg?.content ?? '').length;
        const fin = ch?.finish_reason ?? '-';
        this.logger.log(`AI dbg [${tag}]: finish=${fin} tools=${hasTools} types=${types} contentLen=${contentLen}`);
    }

    private logResponsesShape(resp: any, tag: string) {
        const fr = resp?.finish_reason ?? resp?.output?.[0]?.stop_reason ?? '-';
        const usage = resp?.usage ? JSON.stringify(resp.usage) : '';
        this.logger.log(`AI dbg [${tag}]: finish=${fr} usage=${usage}`);
    }

    private dumpAiRaw(resp: OpenAI.Chat.Completions.ChatCompletion, raw: string, tag: string) {
        try {
            const path = require('node:path');
            const outDir = path.join(process.cwd(), 'tmp');
            const choice = resp.choices?.[0];
            const toolArgs = (() => {
                try {
                    const tc = choice?.message?.tool_calls?.[0] as any;
                    return tc?.function?.arguments ?? '';
                } catch {
                    return '';
                }
            })();
            const usage = resp.usage ? JSON.stringify(resp.usage) : '';
            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            const payload =
                `tag=${tag}\nfinish_reason=${choice?.finish_reason}\nusage=${usage}\n\nTOOL_ARGS:\n${toolArgs}\n\nCONTENT:\n${raw}`;
            require('node:fs').mkdirSync(outDir, { recursive: true });
            require('node:fs').writeFileSync(path.join(outDir, `ai-last-${tag}-${stamp}.txt`), payload);
            this.logger.log(`AI dbg: raw dumped to tmp/ai-last-${tag}-${stamp}.txt`);
        } catch (e) {
            this.logger.warn(`AI dbg: failed to write dump file: ${(e as Error).message}`);
        }
    }

    private dumpResponsesRaw(resp: any, raw: string, tag: string) {
        try {
            const path = require('node:path');
            const outDir = path.join(process.cwd(), 'tmp');
            require('node:fs').mkdirSync(outDir, { recursive: true });
            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            const payload =
                `tag=${tag}\nfinish_reason=${resp?.finish_reason ?? resp?.output?.[0]?.stop_reason}\nusage=${JSON.stringify(
                    resp?.usage ?? {},
                )}\n\nRAW:\n${raw}\n\nOUTPUT:\n${JSON.stringify(resp?.output ?? {}, null, 2)}`;
            require('node:fs').writeFileSync(path.join(outDir, `ai-last-${tag}-${stamp}.txt`), payload);
            this.logger.log(`AI dbg: raw dumped to tmp/ai-last-${tag}-${stamp}.txt`);
        } catch (e) {
            this.logger.warn(`AI dbg: failed to write responses dump: ${(e as Error).message}`);
        }
    }

    private dumpRawText(text: string, tag: string) {
        try {
            const path = require('node:path');
            const outDir = path.join(process.cwd(), 'tmp');
            require('node:fs').mkdirSync(outDir, { recursive: true });
            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            require('node:fs').writeFileSync(path.join(outDir, `ai-raw-${tag}-${stamp}.txt`), text, 'utf8');
            this.logger.log(`AI dbg: text dumped to tmp/ai-raw-${tag}-${stamp}.txt`);
        } catch (e) {
            this.logger.warn(`AI dbg: failed to write raw text: ${(e as Error).message}`);
        }
    }

    /** Ulož normalizované otázky do ./tmp jako JSON. */
    private dumpQuestionsToFile(qs: AiQuestion[], model: string, tag: string) {
        try {
            const path = require('node:path');
            const outDir = path.join(process.cwd(), 'tmp');
            require('node:fs').mkdirSync(outDir, { recursive: true });
            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            const data = { tag, model, count: qs.length, qs };
            require('node:fs').writeFileSync(
                path.join(outDir, `ai-qs-${tag}-${stamp}.json`),
                JSON.stringify(data, null, 2),
                'utf8',
            );
            this.logger.log(`AI dbg: questions dumped to tmp/ai-qs-${tag}-${stamp}.json (${qs.length} items)`);
        } catch (e) {
            this.logger.warn(`AI dbg: failed to write questions file: ${(e as Error).message}`);
        }
    }

    private filterAndCapByMix(qs: AiQuestion[], mix?: Record<string, number>): AiQuestion[] {
        const caps: Record<string, number> = {};
        for (const [k, v] of Object.entries(mix ?? {})) {
            const key = k.toLowerCase().trim();
            const n = Number(v);
            if (n > 0) caps[key] = n;
        }
        if (Object.keys(caps).length === 0) return qs.filter(q => q.k === 'mcq');

        const kept: AiQuestion[] = [];
        const used: Record<string, number> = {};
        for (const q of qs) {
            const k = q.k as string;
            if (!(k in caps)) continue;                    // zahodíme nepovolené typy
            const u = used[k] ?? 0;
            if (u >= caps[k]) continue;                    // už máme dost tohoto typu
            kept.push(q);
            used[k] = u + 1;
        }
        return kept;
    }
}
