import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiResponse, ApiTags, ApiNotFoundResponse, ApiForbiddenResponse } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { CreateFolderDto } from './dto/create-folder.dto';
import { FolderResponseDto } from './dto/folder.dto';
import { UpdateFolderDto } from './dto/update-folder.dto';
import { FoldersService } from './folders.service';

@ApiTags('Folders')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('api/folders')
export class FoldersController {
    constructor(private readonly folders: FoldersService) { }

    @Post()
    @ApiOperation({ summary: 'Vytvoří novou složku' })
    @ApiBody({
        type: CreateFolderDto,
        examples: {
            Basic: { summary: 'Pouze povinný název', value: { name: 'Školní materiály', color: "#1976d2", icon: "PrecisionManufacturing" } },
            WithColorAndIcon: { summary: 'S barvou a ikonkou', value: { name: 'Projekt X', color: '#00CCFF', icon: '📂' } },
        },
    })
    @ApiCreatedResponse({
        description: 'Nově vytvořená složka',
        type: FolderResponseDto,
        schema: { example: { id: '6659f0d2a3b1c2d4e5f67890', name: 'Projekt X', color: '#00CCFF', icon: '📂' } },
    })
    async create(@Body() dto: CreateFolderDto, @CurrentUser() user: { userId: string }) {
        return this.folders.create(dto, user);
    }

    @Get()
    @ApiOperation({ summary: 'Vrátí seznam složek uživatele (seřazeno od nejnovějších)' })
    @ApiOkResponse({
        description: 'Pole složek',
        type: FolderResponseDto,
        isArray: true,
        schema: {
            example: [
                { id: '6659f0d2a3b1c2d4e5f67890', name: 'Projekt X', color: '#00CCFF', icon: '📂' },
                { id: '6659f0d2a3b1c2d4e5f67891', name: 'Školní materiály', color: '#FFAA00', icon: '📁' },
            ],
        },
    })
    async list(@CurrentUser() user: { userId: string }) {
        return this.folders.list(user);
    }

    @Get(':id')
    @ApiOperation({ summary: 'Detail složky' })
    @ApiOkResponse({ description: 'Složka', type: FolderResponseDto })
    @ApiNotFoundResponse({ description: 'Folder not found' })
    @ApiForbiddenResponse({ description: 'Not allowed' })
    async getOne(@Param('id') id: string, @CurrentUser() user: { userId: string }) {
        return this.folders.getOne(id, user);
    }

    @Patch(':id')
    @ApiOperation({ summary: 'Změní vlastnosti složky (name, color, icon)' })
    @ApiBody({
        type: UpdateFolderDto,
        examples: {
            Rename: { summary: 'Přejmenování', value: { name: 'Přejmenovaná složka' } },
            Recolor: { summary: 'Změna barvy', value: { color: '#33CC66' } },
            ChangeIcon: { summary: 'Změna ikony', value: { icon: '🗂️' } },
            Multi: { summary: 'Více změn najednou', value: { name: 'Archiv', color: '#888888', icon: '🗄️' } },
        },
    })
    @ApiOkResponse({
        description: 'Aktualizovaná složka',
        type: FolderResponseDto,
        schema: { example: { id: '6659f0d2a3b1c2d4e5f67890', name: 'Archiv', color: '#888888', icon: '🗄️' } },
    })
    @ApiNotFoundResponse({ description: 'Folder not found' })
    @ApiForbiddenResponse({ description: 'Not allowed' })
    async update(@Param('id') id: string, @Body() dto: UpdateFolderDto, @CurrentUser() user: { userId: string }) {
        return this.folders.update(id, dto, user);
    }

    @Delete(':id')
    @ApiOperation({ summary: 'Smaže složku (pokud je prázdná)' })
    @ApiOkResponse({
        description: 'Výsledek',
        schema: {
            oneOf: [
                { type: 'object', properties: { ok: { type: 'boolean', example: true } } },
                {
                    type: 'object',
                    properties: {
                        ok: { type: 'boolean', example: false },
                        reason: { type: 'string', example: 'Folder not empty' },
                        itemCount: { type: 'number', example: 3 },
                    },
                },
            ],
        },
    })
    @ApiNotFoundResponse({ description: 'Folder not found' })
    @ApiForbiddenResponse({ description: 'Not allowed' })
    async remove(@Param('id') id: string, @CurrentUser() user: { userId: string }) {
        return this.folders.remove(id, user);
    }
}
