import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiExtraModels, ApiOkResponse, ApiOperation, ApiQuery, ApiTags, getSchemaPath } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { TestsService } from './tests.service';
import { GenerateFolderTestsDto } from './dto/generate-folder-tests.dto';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { StoredFile } from '../files/schemas/file.schema';
import { Chunk } from '../files/schemas/chunk.schema';
import { TokenBudgetService } from '../ai/token-budget.service';
import { PreflightQueryDto } from './dto/preflight-query.dto';
import { ChunkSelectorService } from 'src/ai/chunk-selector.service';
import { TestDto } from './dto/test.dto';
import { McqQuestionDto, MsqQuestionDto, TfQuestionDto, ShortQuestionDto, ClozeQuestionDto, MatchQuestionDto, OrderQuestionDto } from './dto/question.dto';

type PreflightChunk = { id: string; text: string; fileId?: string };

@ApiTags('Tests')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller()
@ApiExtraModels(
    TestDto,
    McqQuestionDto,
    MsqQuestionDto,
    TfQuestionDto,
    ShortQuestionDto,
    ClozeQuestionDto,
    MatchQuestionDto,
    OrderQuestionDto,
)
export class TestsController {
    constructor(
        private readonly tests: TestsService,
        @InjectModel(StoredFile.name) private readonly fileModel: Model<StoredFile>,
        @InjectModel(Chunk.name) private readonly chunkModel: Model<Chunk>,
        private readonly tokenBudget: TokenBudgetService,
        private readonly selector: ChunkSelectorService,
    ) { }

    // ===== Generování pro složku =====
    @Post('folders/:folderId/tests/generate')
    @ApiOperation({ summary: 'Vygeneruje testy ve složce' })
    @ApiBody({ type: GenerateFolderTestsDto })
    async generateForFolder(
        @Param('folderId') folderId: string,
        @Body() dto: GenerateFolderTestsDto,
        @CurrentUser() user: { userId: string },
    ) {
        return this.tests.generateForFolder(folderId, user, dto);
    }

    // List testů ve složce
    @Get('folders/:folderId/tests')
    @ApiQuery({ name: 'includeArchived', required: false, schema: { type: 'boolean', default: false } })
    @ApiOkResponse({
        description: 'List of tests in the folder',
        schema: {
            type: 'array',
            items: { $ref: getSchemaPath(TestDto) },
        },
    })
    async listFolderTests(
        @Param('folderId') folderId: string,
        @Query('includeArchived') includeArchived = 'false',
        @CurrentUser() user: { userId: string },
    ) {
        return this.tests.listTestsForFolder(folderId, user, includeArchived === 'true');
    }

    // Detail testu (bez answerKey)
    @Get('tests/:id')
    async getPublicTest(@Param('id') id: string, @CurrentUser() user: { userId: string }) {
        return this.tests.getPublicTest(id, user);
    }

    // ===== Preflight (detailní rozpad tokenů/oken + doporučení) =====
    @Get('folders/:folderId/tests/preflight')
    @ApiOperation({ summary: 'Preflight: odhad tokenů a fit jednotlivých oken' })
    async preflight(
        @Param('folderId') folderId: string,
        @Query() q: PreflightQueryDto,
        @CurrentUser() user?: { userId: string },
    ) {
        const model = q.model || process.env.OPENAI_MODEL || 'gpt-5-mini';

        // Konfig s rozumnými defaulty (konzervativní)
        const contextLimit = Number(q.contextLimit ?? process.env.AI_CONTEXT_LIMIT ?? 4096);
        const maxOutputTokens = Number(q.maxOutputTokens ?? process.env.OPENAI_MAX_OUTPUT_TOKENS ?? 600);
        const schemaOverhead = Number(q.schemaOverhead ?? process.env.AI_SCHEMA_OVERHEAD ?? 200);
        const safety = Number(q.safety ?? process.env.AI_SAFETY_TOKENS ?? 256);

        const windowSize = Number(q.windowSize ?? process.env.AI_WINDOW_SIZE ?? 8);
        const perWindowTarget = Number(q.perWindow ?? process.env.AI_PER_WINDOW_TARGET ?? 4);
        const trimChars = Number(q.trimChars ?? process.env.AI_CHUNK_TRIM_CHARS ?? 900);

        const perFileCap = Number(q.perFileCap ?? process.env.AI_PER_FILE_CAP ?? 12);
        const globalCap = Number(q.globalCap ?? process.env.AI_GLOBAL_CAP ?? 160);
        const includeLines = (q.includeLines ?? 'false') === 'true';

        // 1) Najdi soubory ve složce
        const folderObjId = new Types.ObjectId(folderId);
        const files = await this.fileModel.find({
            folderId: folderObjId,
            ...(user?.userId ? { uploaderId: user.userId } : {}),
        }).lean();

        if (!files.length) {
            return { ok: false, reason: 'Folder has no files', debug: { folderId, lookedForUploader: !!user?.userId } };
        }

        // 2) Načti chunky (jen nezbytná pole, seřazené)
        const fileIdsStr = files.map(f => String(f._id));
        const rawChunks = await this.chunkModel.find(
            { documentId: { $in: fileIdsStr } },
            { text: 1, documentId: 1, index: 1 } as any,
        ).sort({ documentId: 1, index: 1, _id: 1 }).lean();

        if (!rawChunks.length) {
            return { ok: false, reason: 'No chunks for selected files', debug: { files: files.length } };
        }

        // 3) Map + trim
        const allChunks: PreflightChunk[] = rawChunks.map((c: any) => ({
            id: String(c._id),
            fileId: String(c.documentId ?? ''),
            text: String(c.text ?? '').slice(0, trimChars).replace(/\s+/g, ' ').trim(),
        }));

        // 4) Výběr kvalitních chunků + rozdělení do oken (stejně jako při generování)
        //    – pokud selektor nemáš, můžeš nahradit prostým dělením po windowSize.
        const selectedWindows = this.selector.selectBestChunks(
            rawChunks.map((c: any) => ({
                id: String(c._id),
                fileId: String(c.documentId ?? ''),
                index: Number(c.index ?? 0),
                text: String(c.text ?? ''),
            })), {
            perFileCap,
            globalCap,
            windowSize,
            coalesceMaxChars: Number(process.env.AI_COALESCE_MAX_CHARS ?? 900),
            coalesceMinChars: Number(process.env.AI_COALESCE_MIN_CHARS ?? 350),
        },
        );

        // převeď koaleskované okna na „lines“ pro prompt (c:id | text)
        const windowsLines: string[][] = selectedWindows.map(win =>
            win.map(c => `c:${c.id}${c.fileId ? ` f:${c.fileId}` : ''} | ${String(c.text ?? '')
                .slice(0, trimChars).replace(/\s+/g, ' ').trim()}`),
        );

        // fallback, kdyby selektor nic nevybral (nemělo by nastat)
        const chunksSelected = windowsLines.reduce((a, b) => a + b.length, 0);
        if (windowsLines.length === 0) {
            // prosté dělení bez selektoru
            const simple: string[][] = [];
            let buf: string[] = [];
            for (const ch of allChunks) {
                const line = `c:${ch.id}${ch.fileId ? ` f:${ch.fileId}` : ''} | ${ch.text}`;
                buf.push(line);
                if (buf.length >= windowSize) { simple.push(buf); buf = []; }
            }
            if (buf.length) simple.push(buf);
            // použij simple
            simple.forEach(arr => windowsLines.push(arr));
        }

        // 5) Postav system a header (bez řádků)
        const systemMsg = 'Jsi přísný zkoušející. Tvoř otázky výhradně z poskytnutých úryvků. Nehalucinuj.';
        const headerMsg = [
            `Mix je nastaven v generátoru; pro preflight počítáme jen s „horním limitem“ na okno.`,
            `Maximálně ${perWindowTarget} otázek na okno.`,
            `Preferuj explicitně vyložené pojmy, ignoruj boilerplate.`,
            `Úryvky (řádky) následují až v promptu.`,
        ].join('\n');

        // 6) Sestav detailní plán
        const plan = this.tokenBudget.buildDetailedPlan({
            model,
            contextLimit,
            maxOutputTokens,
            schemaOverhead,
            safety,
            systemMsg,
            headerMsg,
            windowsLines,
            perWindowTarget,
            windowSize,
            trimChars,
            totals: {
                files: files.length,
                chunksFound: rawChunks.length,
                chunksSelected: chunksSelected || rawChunks.length,
            },
        });

        // 7) Volitelně přidej „samples“ (první 1–2 řádky z každého okna) jen pro vizuální kontrolu (ne celý text!)
        const samples = includeLines
            ? windowsLines.map((arr, i) => ({ index: i + 1, preview: arr.slice(0, Math.min(2, arr.length)) }))
            : undefined;

        return {
            ok: true,
            plan,
            samples,
        };
    }
}
