import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { TestDocument, Test } from './schemas/test.schema';
import { StoredFile } from '../files/schemas/file.schema';
import { Chunk } from '../files/schemas/chunk.schema';
import { AiService } from '../ai/ai.service';
import { TokenBudgetService } from '../ai/token-budget.service';
import { SocketGateway } from './ws/socket.gateway';
import { AiQuestion } from '../ai/dto/ai-response.dto';
import { ChunkSelectorService } from '../ai/chunk-selector.service';
import { MinioService } from 'src/minio/minio.service';
import { FilesService } from 'src/files/files.service';
import { randomUUID } from 'crypto';

type PreflightChunk = { id: string; text: string; fileId?: string };

// Lokální DB-friendly tvar otázky
type DbQuestion =
    | { type: 'mcq' | 'msq'; text: string; choices: string[]; correct: number[]; meta: { chunkId?: string; fileId?: string } }
    | { type: 'tf'; text: string; truth: boolean; meta: { chunkId?: string; fileId?: string } }
    | { type: 'short'; text: string; answer: string; meta: { chunkId?: string; fileId?: string } }
    | { type: 'cloze'; text: string; gaps: string[]; meta: { chunkId?: string; fileId?: string } }
    | { type: 'match'; text: string; left: string[]; right: string[]; meta: { chunkId?: string; fileId?: string } }
    | { type: 'order'; text: string; items: string[]; meta: { chunkId?: string; fileId?: string } };

@Injectable()
export class TestsService {
    private readonly logger = new Logger(TestsService.name);

    // Defaulty – přepiš ENV proměnnými
    private readonly WINDOW_SIZE = Number(process.env.AI_WINDOW_SIZE ?? 8);
    private readonly PER_WINDOW_TARGET = Number(process.env.AI_PER_WINDOW_TARGET ?? 4);

    constructor(
        @InjectModel(Test.name) private readonly testModel: Model<TestDocument>,
        @InjectModel(StoredFile.name) private readonly fileModel: Model<StoredFile>,
        @InjectModel(Chunk.name) private readonly chunkModel: Model<Chunk>,
        private readonly ai: AiService,
        private readonly tokenBudget: TokenBudgetService,
        private readonly socketGateway: SocketGateway,
        private readonly selector: ChunkSelectorService,
        private readonly minio: MinioService,
        private readonly files: FilesService,
    ) { }

    /**
     * 1) uloží nahraný soubor do MinIO + DB (StoredFile)
     * 2) naparsuje ho na chunky (FilesService.parseAndChunkForUser)
     * 3) vybere chunky do oken a iterativně zavolá AI dle mixu (dynamické cíle + backfill)
     * 4) vytvoří a vrátí uložený Test
     *
     * Posílá průběžné logy na FE pomocí socketId.
     */
    async generateFromSingleFile(
        folderId: string,
        user: { userId: string },
        dto: { title: string; duration: number; mix: Record<string, number>; model?: string },
        file: Express.Multer.File,
        socketId?: string,
    ) {
        const model = dto.model || process.env.OPENAI_MODEL || 'gpt-5-mini';
        const TRIM_CHARS = Number(process.env.AI_CHUNK_TRIM_CHARS ?? 900);
        const WINDOW_SIZE = Number(process.env.AI_WINDOW_SIZE ?? this.WINDOW_SIZE);

        // --- 0) Start ---
        this.logProgress(socketId, 0, 'Příjem souboru…');

        try {
            // --- 1) Uložit soubor do MinIO + DB ---
            const ext = (file.originalname.split('.').pop() || '').toLowerCase();
            const objectName = `${new Date().toISOString().slice(0, 10)}/${randomUUID()}${ext ? '.' + ext : ''}`;

            this.logProgress(socketId, 5, 'Nahrávám soubor do objektového úložiště…');
            await this.minio.uploadObject(objectName, file.buffer, file.mimetype);

            this.logProgress(socketId, 10, 'Zakládám záznam souboru…');
            const createdFile = await this.files.create({
                originalName: file.originalname,
                key: objectName,
                bucket: this.minio.bucketName(),
                mime: file.mimetype,
                size: file.size,
                uploaderId: user.userId,
                folderId,
            });

            const sourceFileId = (createdFile as any)?._id?.toString?.() ?? (createdFile as any).id;

            // --- 2) Parse & chunk ---
            this.logProgress(socketId, 15, 'Parsování souboru a dělení na úryvky…');
            const { chunksInserted } = await this.files.parseAndChunkForUser(
                sourceFileId,
                user,
                Number(process.env.AI_CHUNK_SIZE ?? 1000),
                Number(process.env.AI_CHUNK_OVERLAP ?? 150),
            );
            if (!chunksInserted) {
                this.logProgress(socketId, 100, 'Zpracování selhalo: z dokumentu nevznikly žádné úryvky.');
                return { ok: false, reason: 'No chunks produced from file' };
            }
            this.logProgress(socketId, 25, `Vytvořeno úryvků: ${chunksInserted}. Načítám…`);

            // --- 3) Načti chunky a připrav výběr ---
            const rawChunks = await this.chunkModel
                .find({ documentId: sourceFileId }, { text: 1, index: 1 } as any)
                .sort({ index: 1, _id: 1 })
                .lean();

            if (!rawChunks.length) {
                this.logProgress(socketId, 100, 'Zpracování selhalo: po parsování nebyly nalezeny úryvky.');
                return { ok: false, reason: 'No chunks found (after parsing)' };
            }

            // mapa chunkId → fileId
            const chunkToFile = new Map<string, string>();
            const selChunks = rawChunks.map((c: any) => {
                const id = String(c._id);
                chunkToFile.set(id, sourceFileId);
                return {
                    id,
                    fileId: sourceFileId,
                    index: typeof c.index === 'number' ? c.index : undefined,
                    text: String(c.text ?? '').slice(0, TRIM_CHARS),
                };
            });

            this.logProgress(socketId, 30, 'Výběr nejlepších úryvků a skládání oken…');
            const windows = this.selector.selectBestChunks(selChunks, {
                perFileCap: Number(process.env.AI_PER_FILE_CAP ?? 64),
                globalCap: Number(process.env.AI_GLOBAL_CAP ?? 64),
                windowSize: WINDOW_SIZE,
                coalesceMaxChars: Number(process.env.AI_COALESCE_MAX_CHARS ?? 900),
                coalesceMinChars: Number(process.env.AI_COALESCE_MIN_CHARS ?? 350),
            });

            if (!windows.length) {
                this.logProgress(socketId, 100, 'Zpracování selhalo: nepodařilo se vytvořit kvalitní okna.');
                return { ok: false, reason: 'No quality windows' };
            }
            this.logProgress(socketId, 35, `Launching question generation…`);

            // ====== DYNAMICKÉ CÍLE + BACKFILL ======
            const totalRequested = Object.values(dto.mix || {}).reduce((a, b) => a + Number(b || 0), 0);
            const collected: any[] = [];

            const countByKind = (arr: any[]) =>
                arr.reduce<Record<string, number>>((acc, q: any) => {
                    const k = String(q?.k || '').toLowerCase();
                    acc[k] = (acc[k] ?? 0) + 1;
                    return acc;
                }, {});

            const remainingMix = (mix: Record<string, number>, collectedSoFar: any[]) => {
                const have = countByKind(collectedSoFar);
                const out: Record<string, number> = {};
                for (const [k, v] of Object.entries(mix || {})) {
                    const left = Math.max(0, Number(v || 0) - (have[k] ?? 0));
                    if (left > 0) out[k] = left;
                }
                return out;
            };

            const dynTargetForWindow = (remaining: number, windowsLeft: number) =>
                Math.max(1, Math.ceil(remaining / Math.max(1, windowsLeft)));

            // průběžné procenta pro okna: 35% → 80%
            const progressStart = 35;
            const progressEnd = 80;
            const progressSpan = progressEnd - progressStart;

            for (let i = 0; i < windows.length; i++) {
                const remainingTotal = Math.max(0, totalRequested - collected.length);
                if (remainingTotal <= 0) break;

                const wleft = windows.length - i;
                const targetThisWindow = dynTargetForWindow(remainingTotal, wleft);
                const mixLeft = remainingMix(dto.mix, collected);
                if (!Object.keys(mixLeft).length) break;

                const perWindowMix = this.scaleMix(mixLeft, targetThisWindow);

                const w = windows[i].map((c) => ({
                    id: c.id,
                    fileId: c.fileId ?? selChunks[0].fileId,
                    text: String(c.text ?? '').slice(0, TRIM_CHARS),
                }));

                const pctBefore = progressStart + Math.floor((i / Math.max(1, windows.length)) * progressSpan);
                // this.logProgress(
                //     socketId,
                //     Math.min(79, pctBefore),
                //     `Okno ${i + 1}/${windows.length}: požaduji ${targetThisWindow} (mix: ${JSON.stringify(perWindowMix)})`,
                // );

                const res = await this.ai.generateQuestions(
                    {
                        model,
                        chunks: w,
                        mix: perWindowMix,
                        instruction:
                            'Vytvoř otázky podle mixu. Otázky musí vyplývat POUZE z dodaných úryvků. ' +
                            'U každé otázky vyplň s.c (chunkId) a s.f (fileId).',
                    },
                    socketId, // pokud tvoje AiService umí logovat na socket, přepošleme
                );

                const got = Array.isArray(res?.questions) ? (res!.questions as any[]) : [];
                if (got.length) {
                    this.reconcileQuestionMeta(got, chunkToFile);
                    collected.push(...got);
                }

                const pctAfter = progressStart + Math.floor(((i + 1) / Math.max(1, windows.length)) * progressSpan);
                this.logProgress(
                    socketId,
                    Math.min(80, pctAfter),
                    `Questions prepared — ${collected.length}/${totalRequested}`,
                );
            }

            // backfill – 80% → 88% (1. průchod), 88% → 92% (2. průchod)
            const backfillOnce = async (targetCount: number, pass: number, startPct: number, endPct: number) => {
                const leftMix = remainingMix(dto.mix, collected);
                const leftTotal = Object.values(leftMix).reduce((a, b) => a + b, 0);
                if (leftTotal <= 0) return;

                this.logProgress(socketId, startPct, `Backfill #${pass}: doplňuji chybějící typy (mix: ${JSON.stringify(leftMix)})`);

                const seen = new Set<string>();
                const merged: { id: string; fileId: string; text: string }[] = [];
                for (const win of windows) {
                    for (const c of win) {
                        if (seen.has(c.id)) continue;
                        seen.add(c.id);
                        merged.push({
                            id: c.id,
                            fileId: c.fileId ?? selChunks[0].fileId,
                            text: String(c.text ?? '').slice(0, TRIM_CHARS),
                        });
                    }
                }

                const perMix = this.scaleMix(leftMix, targetCount);

                const res = await this.ai.generateQuestions(
                    {
                        model,
                        chunks: merged,
                        mix: perMix,
                        instruction:
                            'BACKFILL: Doplň chybějící otázky podle mixu výhradně z poskytnutých úryvků. ' +
                            'U každé otázky vyplň s.c (chunkId) a s.f (fileId).',
                    },
                    socketId,
                );

                const got = Array.isArray(res?.questions) ? (res!.questions as any[]) : [];
                if (got.length) {
                    this.reconcileQuestionMeta(got, chunkToFile);
                    collected.push(...got);
                }
                this.logProgress(socketId, endPct, `Backfill #${pass} hotov (+${got.length} ot.), celkem ${collected.length}/${totalRequested}.`);
            };

            let stillMissing = Math.max(0, totalRequested - collected.length);
            if (stillMissing > 0) await backfillOnce(stillMissing, 1, 80, 88);
            stillMissing = Math.max(0, totalRequested - collected.length);
            if (stillMissing > 0) await backfillOnce(Math.min(stillMissing, 16), 2, 88, 92);

            // finální výběr přes mix a limit
            this.logProgress(socketId, 92, 'Finalizuji výběr otázek dle cílového mixu…');
            const finalPicked = this.pickByMixAndTake(collected, dto.mix, totalRequested);
            const finalPickedShuffled = finalPicked.map((q) => this.shuffleMcqMsq(q));
            if (!finalPicked.length) {
                this.logProgress(socketId, 100, 'Zpracování selhalo: nemám žádné otázky pro finální test.');
                return { ok: false, reason: 'No questions for final test' };
            }

            // --- 4) Uložit Test ---
            this.logProgress(socketId, 95, 'Ukládám test do databáze…');
            const testDoc = await this.testModel.create({
                folderId,
                uploaderId: user.userId,
                title: dto.title,
                duration: dto.duration,
                mix: dto.mix,
                questions: finalPickedShuffled.map((q) => this.mapToDbQuestion(q)),
                model,
                archived: false,
            });

            this.logProgress(socketId, 100, 'Hotovo! Test byl úspěšně vygenerován.');

            return {
                ok: true,
                testId: String(testDoc._id),
                fileId: sourceFileId,
                generated: finalPicked.length,
                requested: totalRequested,
                windows: windows.length,
            };
        } catch (err: any) {
            this.logger.error('generateFromSingleFile error', err?.stack || err);
            this.logProgress(socketId, 100, `Chyba: ${err?.message || 'Neznámá chyba při generování.'}`);
            throw err;
        }
    }

    async listTestsForFolder(folderId: string, user: { userId: string }, includeArchived: boolean) {
        return this.testModel
            .find(
                {
                    folderId,
                    uploaderId: user.userId,
                    ...(includeArchived ? {} : { archived: false }),
                }
            )
            .sort({ createdAt: 1, _id: 1 }) // ↑ nejstarší → nejnovější (tie-break přes _id)
            .lean();
    }

    async getPublicTest(id: string, user: { userId: string }) {
        return this.testModel.findOne({ _id: id, uploaderId: user.userId }).lean();
    }

    // ---------- helpers ----------

    private logProgress(socketId: string | undefined, percent: number, msg: string) {
        this.logger.log(`[${percent}%] ${msg}`);
        if (socketId) this.socketGateway.emitProgress(socketId, { percent, msg });
    }

    /** Normalizované škálování mixu na cílový count */
    private scaleMix(mix: Record<string, number>, target: number): Record<string, number> {
        const total = Object.values(mix || {}).reduce((a, b) => a + Number(b || 0), 0) || 1;
        const factor = Math.max(1, total) > 0 ? target / total : 1;
        const out: Record<string, number> = {};
        for (const [k, v] of Object.entries(mix || {})) {
            out[k.toLowerCase().trim()] = Math.max(0, Math.round(Number(v || 0) * factor));
        }
        if (Object.values(out).every((n) => n <= 0)) out['mcq'] = Math.max(1, target);
        return out;
    }

    /** Doplní chybějící s.f (fileId) z mapy chunkId → fileId */
    private reconcileQuestionMeta(qs: AiQuestion[], chunkToFile: Map<string, string>) {
        for (const q of qs as any[]) {
            const s = q.s ?? (q.s = {});
            if (!s.f) {
                const c = s.c;
                if (typeof c === 'string' && chunkToFile.has(c)) {
                    s.f = chunkToFile.get(c);
                }
            }
        }
    }

    /** Vybere otázky dle mixu (typů) a omezí celkovým počtem */
    private pickByMixAndTake(qs: AiQuestion[], mix: Record<string, number>, count: number): AiQuestion[] {
        const caps = this.scaleMix(mix, count);
        const allowed = Object.keys(caps).filter((k) => caps[k] > 0);

        // promíchání (Fisher–Yates)
        const shuffled: AiQuestion[] = [...qs];
        for (let i = shuffled.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }

        const used: Record<string, number> = {};
        const out: AiQuestion[] = [];
        for (const q of shuffled as any[]) {
            const k = String(q.k).toLowerCase().trim();
            if (allowed.length && !allowed.includes(k)) continue;
            const u = used[k] ?? 0;
            if (u >= (caps[k] ?? 0)) continue;
            out.push(q);
            used[k] = u + 1;
            if (out.length >= count) break;
        }
        return out.slice(0, count);
    }

    /** UI-sanitizace textu */
    private sanitizeTextForUi(s: string): string {
        if (!s) return s;
        let x = s;

        // (c:HEX f:HEX) / (c:HEX)
        x = x.replace(/\(\s*c:[0-9a-f]{8,}\s*(?:f:\s*[0-9a-f]{8,}\s*)?\)/gi, '');
        // standalone c:HEX / f:HEX
        x = x.replace(/\b[cf]:[0-9a-f]{8,}\b/gi, '');
        // "Podle/Dle úryvku ..." na začátku
        x = x.replace(/^\s*(?:podle|dle)\s+úryvku(?:\s*\([^)]+\))?\s*:\s*/i, '');
        // volitelně: "viz úryvek/text:"
        x = x.replace(/^\s*viz\s+(?:úryvek|text)\s*:\s*/i, '');
        // whitespace
        x = x.replace(/\s{2,}/g, ' ').replace(/\s+([,.!?;:])/g, '$1').trim();
        return x;
    }

    /** Map AiQuestion → DB-friendly tvar (se sanitizací textů) */
    private mapToDbQuestion(q: AiQuestion & { s?: { c?: string; f?: string } }): DbQuestion {
        const anyQ = q as any;
        const meta = { chunkId: anyQ?.s?.c, fileId: anyQ?.s?.f };
        const clean = (s: string) => this.sanitizeTextForUi(String(s ?? ''));

        switch (anyQ.k) {
            case 'mcq':
            case 'msq':
                return {
                    type: anyQ.k,
                    text: clean(anyQ.t),
                    choices: (anyQ.o ?? []).map((x: any) => clean(String(x ?? ''))),
                    correct: anyQ.ci ?? [],
                    meta,
                };
            case 'tf':
                return { type: 'tf', text: clean(anyQ.t), truth: Boolean(anyQ.r), meta };
            case 'short':
                return { type: 'short', text: clean(anyQ.t), answer: String(anyQ.r ?? ''), meta };
            case 'cloze':
                return { type: 'cloze', text: clean(anyQ.t), gaps: (anyQ.g ?? []).map((x: any) => clean(String(x ?? ''))), meta };
            case 'match':
                return {
                    type: 'match',
                    text: clean(anyQ.t),
                    left: (anyQ.l ?? []).map((x: any) => clean(String(x ?? ''))),
                    right: (anyQ.r ?? []).map((x: any) => clean(String(x ?? ''))),
                    meta,
                };
            case 'order':
                return { type: 'order', text: clean(anyQ.t), items: (anyQ.o ?? []).map((x: any) => clean(String(x ?? ''))), meta };
            default:
                return {
                    type: 'mcq',
                    text: clean(anyQ.t),
                    choices: (anyQ.o ?? []).map((x: any) => clean(String(x ?? ''))),
                    correct: anyQ.ci ?? [],
                    meta,
                };
        }
    }

    // Fisher–Yates (deterministiku můžeš udělat přes seed, ale pro začátek stačí Math.random)
    private shuffleArrayInPlace<T>(arr: T[]): void {
        for (let i = arr.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [arr[i], arr[j]] = [arr[j], arr[i]];
        }
    }

    /** Zamíchá pořadí možností u MCQ/MSQ a přemapuje správné indexy (ci). */
    private shuffleMcqMsq(q: AiQuestion): AiQuestion {
        if (q.k !== 'mcq' && q.k !== 'msq') return q;

        const choices = Array.isArray(q.o) ? [...q.o] : [];
        if (choices.length < 2) return q;

        // vytvoř pole původních indexů a zamíchej je
        const order = Array.from({ length: choices.length }, (_, i) => i);
        this.shuffleArrayInPlace(order);

        // nové pořadí možností
        const shuffledChoices = order.map((oldIdx) => choices[oldIdx]);

        // mapování: původní index -> nová pozice
        const oldToNew = new Map<number, number>();
        order.forEach((oldIdx, newPos) => oldToNew.set(oldIdx, newPos));

        // přemapuj správné indexy
        const newCi = (q.ci ?? [])
            .map((old) => oldToNew.get(old))
            .filter((v): v is number => typeof v === 'number');

        // u MSQ odstraň případné duplicity (pro jistotu)
        const dedupCi = Array.from(new Set(newCi));

        return { ...q, o: shuffledChoices, ci: dedupCi };
    }

}
