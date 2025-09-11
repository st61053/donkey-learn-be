import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { TestDocument, Test } from './schemas/test.schema';
import { StoredFile } from '../files/schemas/file.schema';
import { Chunk } from '../files/schemas/chunk.schema';
import { GenerateFolderTestsDto } from './dto/generate-folder-tests.dto';
import { AiService } from '../ai/ai.service';
import { TokenBudgetService } from '../ai/token-budget.service';
import { SocketGateway } from './ws/socket.gateway';
import { AiQuestion } from '../ai/dto/ai-response.dto';
import { ChunkSelectorService, SelChunk } from '../ai/chunk-selector.service';

type PreflightChunk = { id: string; text: string; fileId?: string };

// Lokální DB-friendly tvar otázky (nemusíš exportovat; je to jen pro typovou pohodu)
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
    ) { }

    /**
     * Per-file generování:
     *  - pro KAŽDÝ soubor poskládáme okna jen z jeho chunků a voláme AI
     *  - zastavíme se, jakmile nasbíráme ≥ topicCount otázek pro daný soubor (nebo dojdou okna)
     *  - pak vytvoříme finální test z celého poolu (napříč soubory) o velikosti finalCount
     */
    async generateForFolder(folderId: string, user: { userId: string }, dto: GenerateFolderTestsDto) {
        const {
            topicCount = 4,       // kolik otázek do topic testu pro každý soubor
            finalCount = 6,       // finální test
            archiveExisting = true,
            strategy = 'ai',
            mix = { mcq: 5 },     // např. jen MCQ
            model = process.env.OPENAI_MODEL || 'gpt-4o-mini',
            socketId,
        } = dto;

        this.logProgress(socketId, 0, 'Starting folder generation');

        // 1) archivace existujících testů (volitelně)
        if (archiveExisting) {
            await this.testModel.updateMany(
                { folderId, uploaderId: user.userId, archived: false },
                { archived: true },
            );
            this.logProgress(socketId, 3, 'Archived existing tests');
        }

        // 2) soubory ve složce
        const files = await this.fileModel.find({
            folderId: new Types.ObjectId(folderId),
            uploaderId: user.userId,
        }).lean();

        if (!files.length) {
            this.logProgress(socketId, 100, 'No files in folder');
            return { ok: false, reason: 'No files in folder' };
        }

        const fileIdsStr = files.map((f) => String(f._id));

        // 3) chunky všech souborů (trim už v dotazu – šetří payload)
        const TRIM_CHARS = Number(process.env.AI_CHUNK_TRIM_CHARS ?? 900);
        const docs = await this.chunkModel.aggregate([
            { $match: { documentId: { $in: fileIdsStr } } },
            { $sort: { documentId: 1, index: 1, _id: 1 } },
            { $project: { documentId: 1, index: 1, text: { $substrCP: ['$text', 0, TRIM_CHARS] } } },
        ]).exec();

        if (!docs.length) {
            this.logProgress(socketId, 100, 'No chunks for files (after trimming)');
            return { ok: false, reason: 'No chunks for files' };
        }

        // Mapa chunkId -> fileId (pojistka pro doplnění s.f, když ho AI vynechá)
        const chunkToFile = new Map<string, string>();
        for (const d of docs as any[]) {
            chunkToFile.set(String(d._id), String(d.documentId));
        }

        // 4) SelChunk seznam
        const allSelChunks: SelChunk[] = (docs as any[]).map((d) => ({
            id: String(d._id ?? ''),
            text: String(d.text ?? ''),
            fileId: String(d.documentId ?? ''),
            index: typeof d.index === 'number' ? d.index : undefined,
        }));

        // 5) Per-file okna (žádné míchání souborů v jednom okně)
        const WINDOW_SIZE = Number(process.env.AI_WINDOW_SIZE ?? this.WINDOW_SIZE);
        const PER_WINDOW_TARGET = Number(process.env.AI_PER_WINDOW_TARGET ?? this.PER_WINDOW_TARGET);
        const perFileCap = Number(process.env.AI_PER_FILE_CAP ?? 24); // kolik chunků může selector vzít pro jeden soubor

        // -> seskup chunky podle souboru
        const chunksByFile = new Map<string, SelChunk[]>();

        for (const sc of allSelChunks) {
            const fid = sc.fileId ?? '';   // zúžíme na string
            if (!fid) continue;            // bez fileId vynecháme (nechceš je v per-file)
            const bucket = chunksByFile.get(fid);
            if (bucket) bucket.push(sc);
            else chunksByFile.set(fid, [sc]);
        }

        // 6) Generování po souborech se stop-podmínkou topicCount
        const allQuestionsPool: AiQuestion[] = []; // globální pool pro finál
        const perFileResults: { fileId: string; count: number; testId?: string }[] = [];

        let fileIndex = 0;
        for (const f of files) {
            const fid = String(f._id);
            const fileChunks = chunksByFile.get(fid) ?? [];

            fileIndex++;
            const filePctBase = 10 + Math.round((fileIndex - 1) * (70 / Math.max(1, files.length))); // jen pro hezčí progress

            if (!fileChunks.length) {
                perFileResults.push({ fileId: fid, count: 0 });
                this.logProgress(socketId, filePctBase, `No chunks for file ${fid}`);
                continue;
            }

            // Pro tento soubor nech selector vybrat jen jeho nejlepší chunky a poskládat okna
            const windowsForFile = this.selector.selectBestChunks(fileChunks, {
                perFileCap,
                globalCap: perFileCap, // v per-file režimu klidně stejné číslo
                windowSize: WINDOW_SIZE,
                coalesceMaxChars: Number(process.env.AI_COALESCE_MAX_CHARS ?? 900),
                coalesceMinChars: Number(process.env.AI_COALESCE_MIN_CHARS ?? 350),
            });

            if (!windowsForFile.length) {
                perFileResults.push({ fileId: fid, count: 0 });
                this.logProgress(socketId, filePctBase, `No quality chunks for file ${fid}`);
                continue;
            }

            const perFileBag: AiQuestion[] = []; // sem sbíráme otázky jen z tohoto souboru

            for (let wIdx = 0; wIdx < windowsForFile.length; wIdx++) {
                const w = windowsForFile[wIdx].map(c => ({ id: c.id, text: c.text, fileId: c.fileId })) as PreflightChunk[];
                const pct = filePctBase + Math.round(((wIdx + 1) / windowsForFile.length) * (70 / Math.max(1, files.length)));
                this.logProgress(socketId, pct, `File ${fileIndex}/${files.length}: window ${wIdx + 1}/${windowsForFile.length} (${w.length} chunks)`);

                // Volání AI pro toto okno
                const res = await this.ai.generateQuestions({
                    model,
                    chunks: w,
                    mix: this.scaleMix(mix, PER_WINDOW_TARGET),
                    instruction: 'Vytvoř otázky podle mixu. Otázky musí vyplývat POUZE z dodaných úryvků. U každé otázky vyplň s.c (chunkId) a s.f (fileId).',
                    socketId,
                }, socketId);

                const got: AiQuestion[] = Array.isArray(res?.questions) ? (res!.questions as AiQuestion[]) : [];
                if (got.length) {
                    // doplň meta s.f z chunkToFile, pokud chybí
                    this.reconcileQuestionMeta(got, chunkToFile);

                    // přidej do globálního poolu (pro finále)
                    allQuestionsPool.push(...got);

                    // filtr – ber jen otázky z tohoto souboru
                    const fromThisFile = got.filter((q: any) => String(q?.s?.f ?? '') === fid);

                    if (fromThisFile.length) {
                        perFileBag.push(...fromThisFile);
                    }
                }

                // stop podmínka – nasbírali jsme dost pro topic test?
                if (perFileBag.length >= topicCount) break;
            }

            // Výběr do topic testu podle mixu (např. jen MCQ) a limitu topicCount
            const pickedAiQs: AiQuestion[] = this.pickByMixAndTake(perFileBag, mix, topicCount);

            if (!pickedAiQs.length) {
                perFileResults.push({ fileId: fid, count: 0 });
                continue;
            }

            // Ulož topic test pro tento soubor – DB-friendly klíče
            const created = await this.testModel.create({
                folderId,
                uploaderId: user.userId,
                questions: pickedAiQs.map((q) => this.mapToDbQuestion(q)),
                model,
                archived: false,
                // sourceFileId: fid, // pokud chceš, přidej do schématu Test
            });

            perFileResults.push({ fileId: fid, count: pickedAiQs.length, testId: String(created._id) });
        }

        // 7) Finální test napříč všemi nasbíranými otázkami
        this.logProgress(socketId, 94, 'Creating final test');

        if (!allQuestionsPool.length) {
            this.logProgress(socketId, 100, 'AI returned no valid questions');
            return { ok: false, reason: 'AI returned no valid questions' };
        }

        const finalPicked: AiQuestion[] = this.pickByMixAndTake(allQuestionsPool, mix, finalCount);
        if (!finalPicked.length) {
            this.logProgress(socketId, 100, 'No questions for final test');
            return { ok: false, reason: 'No questions for final test' };
        }

        const finalTest = await this.testModel.create({
            folderId,
            uploaderId: user.userId,
            questions: finalPicked.map((q) => this.mapToDbQuestion(q)),
            model,
            archived: false,
            // type: 'final'
        });

        this.logProgress(
            socketId,
            100,
            `Done. Created ${perFileResults.filter(r => r.count > 0).length} topic tests + final (${finalPicked.length}).`,
        );

        return {
            ok: true,
            perFile: perFileResults,
            finalId: finalTest._id,
            finalCount: finalPicked.length,
        };
    }

    // ====== Preflight (bez změny) ======
    async preflight(folderId: string, user: { userId: string }, model: string) {
        const files = await this.fileModel.find({
            folderId: new Types.ObjectId(folderId),
            uploaderId: user.userId,
        }).lean();

        if (!files.length) return { ok: false, reason: 'Folder has no files' };

        const fileIdsStr = files.map((f) => String(f._id));
        const rawChunks = await this.chunkModel
            .find({ documentId: { $in: fileIdsStr } }, { text: 1 } as any)
            .sort({ _id: 1 })
            .lean();

        if (!rawChunks.length) return { ok: false, reason: 'No chunks for selected files' };

        const sample = rawChunks.slice(0, 64).map((c: any) => String(c.text ?? '').slice(0, 800));
        const est = this.tokenBudget.estimatePromptSize(sample, 'Instruction example');

        return {
            ok: true,
            files: files.length,
            chunks: rawChunks.length,
            estimatedTokens: est,
            model,
            windowSize: this.WINDOW_SIZE,
            perWindowTarget: this.PER_WINDOW_TARGET,
        };
    }

    async listTestsForFolder(folderId: string, user: { userId: string }, includeArchived: boolean) {
        return this.testModel.find({
            folderId,
            uploaderId: user.userId,
            ...(includeArchived ? {} : { archived: false }),
        }).lean();
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
            out[k.toLowerCase().trim()] = Math.max(0, Math.round((Number(v || 0)) * factor));
        }
        if (Object.values(out).every((n) => n <= 0)) out['mcq'] = Math.max(1, target);
        return out;
    }

    /** Doplní chybějící s.f (fileId) z mapy chunkId → fileId (ponechá s.c, pokud je) */
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
        const allowed = Object.keys(caps).filter(k => caps[k] > 0);

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

    /** UI-sanitizace (odstraní "(c:..., f:...)" a "Podle úryvku:" apod.) */
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
                    meta
                };
            case 'tf':
                return { type: 'tf', text: clean(anyQ.t), truth: Boolean(anyQ.r), meta };
            case 'short':
                return { type: 'short', text: clean(anyQ.t), answer: String(anyQ.r ?? ''), meta };
            case 'cloze':
                return { type: 'cloze', text: clean(anyQ.t), gaps: (anyQ.g ?? []).map((x: any) => clean(String(x ?? ''))), meta };
            case 'match':
                return { type: 'match', text: clean(anyQ.t), left: (anyQ.l ?? []).map((x: any) => clean(String(x ?? ''))), right: (anyQ.r ?? []).map((x: any) => clean(String(x ?? ''))), meta };
            case 'order':
                return { type: 'order', text: clean(anyQ.t), items: (anyQ.o ?? []).map((x: any) => clean(String(x ?? ''))), meta };
            default:
                return {
                    type: 'mcq',
                    text: clean(anyQ.t),
                    choices: (anyQ.o ?? []).map((x: any) => clean(String(x ?? ''))),
                    correct: anyQ.ci ?? [],
                    meta
                };
        }
    }
}
