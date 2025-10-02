import {
    Body, Controller, Get, Query, Param, Delete, UseGuards, Patch
} from '@nestjs/common';
import {
    ApiTags, ApiBody, ApiQuery, ApiBearerAuth, ApiOkResponse, ApiOperation,
    ApiBadRequestResponse, ApiForbiddenResponse, ApiNotFoundResponse, ApiExtraModels, getSchemaPath
} from '@nestjs/swagger';

import { FilesService } from './files.service';
import { MinioService } from '../minio/minio.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { FileResponseDto } from './schemas/file.schema';
import { MoveFileDto } from './dto/move-file.dto';
import { ChunkResponseDto } from './dto/chunk-response.dto';

@ApiTags('Files')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@ApiExtraModels(FileResponseDto, ChunkResponseDto)
@Controller('files')
export class FilesController {
    constructor(private readonly files: FilesService, private readonly minio: MinioService) { }

    @Get()
    @ApiOperation({ summary: 'Seznam souborů uživatele (fulltext + filtr na složku, stránkování)' })
    @ApiQuery({
        name: 'q',
        required: false,
        description: 'Fulltext v názvu (case-insensitive contains)',
        schema: { type: 'string' },
        examples: {
            containsPdf: { summary: 'Hledat PDF', value: 'pdf' },
            containsInvoice: { summary: 'Hledat faktury', value: 'invoice' },
        },
    })
    @ApiQuery({
        name: 'folderId',
        required: false,
        description: 'Filtrovat podle ID složky',
        schema: { type: 'string' },
        examples: { someFolder: { summary: 'Konkrétní složka', value: '66cf19ee2e3a4b5c6d7e8f8f' } },
    })
    @ApiQuery({ name: 'limit', required: false, schema: { type: 'number', default: 50, minimum: 1, maximum: 200 } })
    @ApiQuery({ name: 'skip', required: false, schema: { type: 'number', default: 0, minimum: 0 } })
    @ApiOkResponse({
        description: 'Pole souborů',
        schema: {
            type: 'array',
            items: { $ref: getSchemaPath(FileResponseDto) },
            examples: {
                basic: {
                    summary: 'Dva soubory',
                    value: [
                        {
                            id: '66cf1a1f2e3a4b5c6d7e8f90',
                            originalName: 'invoice-2025-08-01.pdf',
                            key: '2025-08-29/6a2d9e3c-0a7b-4b8e-af1d-1a2b3c4d5e6f.pdf',
                            bucket: 'documents',
                            mime: 'application/pdf',
                            size: 482391,
                            uploaderId: 'user_123',
                            folderId: '66cf19ee2e3a4b5c6d7e8f8f',
                            tags: ['invoice', '2025', 'finance'],
                            status: 'UPLOADED',
                            pageCount: 12,
                            createdAt: '2025-08-29T18:04:12.345Z',
                            updatedAt: '2025-08-29T18:04:12.345Z',
                        },
                        {
                            id: '66cf1a202e3a4b5c6d7e8f91',
                            originalName: 'scan-contract-2025.png',
                            key: '2025-08-29/7b3e0a9b-1b2c-4c8e-8f2e-e1f0a2b3c4d5.png',
                            bucket: 'documents',
                            mime: 'image/png',
                            size: 238112,
                            uploaderId: 'user_123',
                            folderId: '66cf19ee2e3a4b5c6d7e8f8f',
                            tags: ['contract'],
                            status: 'PARSED',
                            pageCount: null,
                            createdAt: '2025-08-28T10:11:12.000Z',
                            updatedAt: '2025-08-28T10:11:12.000Z',
                        },
                    ],
                },
            },
        },
    })
    @ApiForbiddenResponse({ description: 'Nedostatečná oprávnění' })
    async list(
        @Query('q') q: string | undefined,
        @Query('folderId') folderId: string | undefined,
        @Query('limit') limit = 50,
        @Query('skip') skip = 0,
        @CurrentUser() user: { userId: string; roles: string[] },
    ) {
        const filter: any = {};
        if (q) filter.originalName = { $regex: q, $options: 'i' };
        if (folderId) filter.folderId = folderId;

        const rows = await this.files.findAllForUser(user, filter, Number(limit), Number(skip));

        return rows.map((r: any) => ({
            id: r._id?.toString?.() ?? r.id,
            originalName: r.originalName,
            key: r.key,
            bucket: r.bucket,
            mime: r.mime,
            size: r.size,
            uploaderId: r.uploaderId,
            folderId: r.folderId?.toString?.() ?? r.folderId,
            tags: r.tags ?? [],
            status: r.status,
            pageCount: r.pageCount ?? null,
            createdAt: r.createdAt?.toISOString?.() ?? r.createdAt,
            updatedAt: r.updatedAt?.toISOString?.() ?? r.updatedAt,
        }));
    }

    @Get(':id')
    @ApiOperation({ summary: 'Detail souboru' })
    @ApiOkResponse({ description: 'Soubor', type: FileResponseDto })
    @ApiNotFoundResponse({ description: 'File not found' })
    @ApiForbiddenResponse({ description: 'Not allowed' })
    async getOne(@Param('id') id: string, @CurrentUser() user: any) {
        return await this.files.findByIdForUser(id, user);
    }

    @Get(':id/download')
    @ApiOperation({ summary: 'Získat pre-signed URL pro stažení' })
    @ApiQuery({
        name: 'expiresSec',
        required: false,
        schema: { type: 'number', default: 3600, minimum: 60, maximum: 86400 },
    })
    @ApiOkResponse({
        description: 'Pre-signed URL',
        schema: {
            type: 'object',
            properties: { url: { type: 'string' } },
            example: { url: 'https://minio.local/presigned?X-Amz-Algorithm=AWS4-HMAC-SHA256&...' },
        },
    })
    @ApiNotFoundResponse({ description: 'File not found' })
    @ApiForbiddenResponse({ description: 'Not allowed' })
    async download(@Param('id') id: string, @CurrentUser() user: any, @Query('expiresSec') expiresSec = 3600) {
        const url = await this.files.getDownloadUrlForUser(id, user, Number(expiresSec));
        return { url };
    }

    @Delete(':id')
    @ApiOperation({ summary: 'Smazat soubor (včetně objektu a chunků)' })
    @ApiOkResponse({ schema: { type: 'object', properties: { ok: { type: 'boolean', example: true } } } })
    @ApiNotFoundResponse({ description: 'File not found' })
    @ApiForbiddenResponse({ description: 'Not allowed' })
    async delete(@Param('id') id: string, @CurrentUser() user: any) {
        return await this.files.removeForUser(id, user);
    }

    @Patch(':id/folder')
    @ApiOperation({ summary: 'Přesun souboru do jiné složky' })
    @ApiBody({
        type: MoveFileDto,
        examples: {
            move: { value: { folderId: '66cf19ee2e3a4b5c6d7e8f8f' } },
        },
    })
    @ApiOkResponse({ schema: { type: 'object', properties: { ok: { type: 'boolean', example: true } } } })
    @ApiBadRequestResponse({ description: 'Folder not found or not owned by user' })
    @ApiNotFoundResponse({ description: 'File not found' })
    @ApiForbiddenResponse({ description: 'Not allowed' })
    async move(
        @Param('id') id: string,
        @Body() body: MoveFileDto,
        @CurrentUser() user: { userId: string; roles: string[] },
    ) {
        return this.files.moveToFolderForUser(id, body.folderId, user);
    }

    @Get(':id/chunks')
    @ApiOperation({ summary: 'Seznam chunků dokumentu' })
    @ApiOkResponse({
        description: 'Chunky seřazené podle indexu',
        schema: {
            type: 'array',
            items: { $ref: getSchemaPath(ChunkResponseDto) },
            example: [
                {
                    id: '66d00112233aa44bb55cc66d',
                    documentId: '66cf1a1f2e3a4b5c6d7e8f90',
                    index: 0,
                    text: 'Lorem ipsum dolor sit amet…',
                    startOffset: 0,
                    endOffset: 1000,
                    pageFrom: 1,
                    pageTo: 1,
                    createdAt: '2025-08-29T18:04:12.345Z',
                    updatedAt: '2025-08-29T18:04:12.345Z'
                },
                {
                    id: '66d00112233aa44bb55cc66e',
                    documentId: '66cf1a1f2e3a4b5c6d7e8f90',
                    index: 1,
                    text: 'Consectetur adipiscing elit…',
                    startOffset: 850,
                    endOffset: 1850,
                    pageFrom: 1,
                    pageTo: 2,
                    createdAt: '2025-08-29T18:04:12.345Z',
                    updatedAt: '2025-08-29T18:04:12.345Z'
                }
            ],
        },
    })
    @ApiNotFoundResponse({ description: 'File not found' })
    @ApiForbiddenResponse({ description: 'Not allowed' })
    async chunks(@Param('id') id: string, @CurrentUser() user?: { userId: string; roles: string[] }) {
        return await this.files.listChunksForUser(id, user!);
    }
}
