import {
    BadRequestException,
    Body,
    Controller,
    Get,
    Param,
    Patch,
    Post,
    Query,
    UploadedFile,
    UseGuards,
    UseInterceptors,
} from '@nestjs/common';
import {
    ApiBearerAuth,
    ApiBody,
    ApiConsumes,
    ApiExtraModels,
    ApiOkResponse,
    ApiOperation,
    ApiQuery,
    ApiTags,
    getSchemaPath,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { TestsService } from './tests.service';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { StoredFile } from '../files/schemas/file.schema';
import { Chunk } from '../files/schemas/chunk.schema';
import { TokenBudgetService } from '../ai/token-budget.service';
import { PreflightQueryDto } from './dto/preflight-query.dto';
import { ChunkSelectorService } from 'src/ai/chunk-selector.service';
import { TestDto } from './dto/test.dto';
import {
    McqQuestionDto,
    MsqQuestionDto,
    TfQuestionDto,
    ShortQuestionDto,
    ClozeQuestionDto,
    MatchQuestionDto,
    OrderQuestionDto,
} from './dto/question.dto';
import { FileInterceptor } from '@nestjs/platform-express';
import { GenerateFromFileDto } from './dto/generate-from-file.dto';

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

    @Post('api/folders/:folderId/tests')
    @UseInterceptors(FileInterceptor('file'))
    @ApiOperation({ summary: 'Nahrát soubor, naparsovat ho a vygenerovat z něj test pomocí LLM' })
    @ApiBearerAuth()
    @ApiConsumes('multipart/form-data')
    @ApiQuery({
        name: 'socketId',
        required: false,
        description:
            'Volitelný identifikátor webového socketu (FE spojení), kam budou posílány průběžné logy a procenta.',
    })
    @ApiBody({
        description: 'Form-data s metadaty testu a binárním souborem',
        schema: {
            type: 'object',
            properties: {
                title: { type: 'string', example: 'Test' },
                duration: { type: 'number', example: 30 },
                mix: {
                    type: 'object',
                    example: { mcq: 26, tf: 1, msq: 2, cloze: 0 },
                    additionalProperties: { type: 'number' },
                },
                model: { type: 'string', example: 'gpt-5-mini' },
                file: { type: 'string', format: 'binary' },
            },
            required: ['title', 'duration', 'mix', 'file'],
        },
    })
    async generateFromSingleFile(
        @Param('folderId') folderId: string,
        @UploadedFile() file: Express.Multer.File | undefined,
        @Body() dto: GenerateFromFileDto,
        @CurrentUser() user: { userId: string },
        @Query('socketId') socketId?: string,
    ) {
        if (!file) throw new BadRequestException('No file uploaded');
        return this.tests.generateFromSingleFile(folderId, user, dto, file, socketId);
    }

    // List testů ve složce
    @Get('api/folders/:folderId/tests')
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
    @Get('api/tests/:id')
    async getPublicTest(@Param('id') id: string, @CurrentUser() user: { userId: string }) {
        return this.tests.getPublicTest(id, user);
    }
}
