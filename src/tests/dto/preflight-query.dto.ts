import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBooleanString, IsInt, IsOptional, IsPositive, IsString, Min } from 'class-validator';

export class PreflightQueryDto {
    @ApiPropertyOptional({ description: 'Model pro odhad', example: 'gpt-5-mini' })
    @IsOptional() @IsString()
    model?: string;

    @ApiPropertyOptional({ description: 'Cílový finální počet otázek po sloučení oken', example: 20 })
    @IsOptional() @IsInt() @Min(1)
    desired?: number;

    @ApiPropertyOptional({ description: 'Max. otázek na 1 okno (AI mix/target)', example: 4 })
    @IsOptional() @IsInt() @Min(1)
    perWindow?: number;

    @ApiPropertyOptional({ description: 'Počet chunků v jednom okně', example: 8 })
    @IsOptional() @IsInt() @Min(1)
    windowSize?: number;

    @ApiPropertyOptional({ description: 'Max. znaků na chunk (trim před odesláním do AI)', example: 900 })
    @IsOptional() @IsInt() @Min(100)
    trimChars?: number;

    @ApiPropertyOptional({ description: 'Efektivní context limit modelu (tokeny)', example: 4096 })
    @IsOptional() @IsInt() @Min(1024)
    contextLimit?: number;

    @ApiPropertyOptional({ description: 'Max. tokenů pro výstup (completion)', example: 600 })
    @IsOptional() @IsInt() @Min(64)
    maxOutputTokens?: number;

    @ApiPropertyOptional({ description: 'Rezerva pro schéma nástroje / JSON (tokeny)', example: 200 })
    @IsOptional() @IsInt() @Min(0)
    schemaOverhead?: number;

    @ApiPropertyOptional({ description: 'Bezpečnostní rezerva (tokeny)', example: 256 })
    @IsOptional() @IsInt() @Min(0)
    safety?: number;

    @ApiPropertyOptional({ description: 'Top-K chunků z každého souboru před globalním výběrem', example: 12 })
    @IsOptional() @IsInt() @Min(1)
    perFileCap?: number;

    @ApiPropertyOptional({ description: 'Celkový strop chunků před dělením do oken', example: 160 })
    @IsOptional() @IsInt() @Min(1)
    globalCap?: number;

    @ApiPropertyOptional({ description: 'Vrátit i vybrané textové řádky (pro ladění)', example: false })
    @IsOptional() @IsBooleanString()
    includeLines?: string;
}