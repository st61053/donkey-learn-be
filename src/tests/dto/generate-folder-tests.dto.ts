import { ApiProperty } from '@nestjs/swagger';
import {
    IsBoolean,
    IsNumber,
    IsObject,
    IsOptional,
    IsString,
    Min,
} from 'class-validator';

export class GenerateFolderTestsDto {
    @ApiProperty({
        description: 'Počet otázek na téma (výchozí 5)',
        example: 4,
        required: false,
    })
    @IsOptional()
    @IsNumber()
    @Min(1)
    topicCount?: number;

    @ApiProperty({
        description: 'Celkový počet otázek ve finálním testu (výchozí 20)',
        example: 6,
        required: false,
    })
    @IsOptional()
    @IsNumber()
    @Min(1)
    finalCount?: number;

    @ApiProperty({
        description: 'Archivovat existující testy před generováním?',
        example: true,
        required: false,
    })
    @IsOptional()
    @IsBoolean()
    archiveExisting?: boolean;

    @ApiProperty({
        description: 'Strategie generování (ai | fake)',
        example: 'ai',
        required: false,
    })
    @IsOptional()
    @IsString()
    strategy?: string;

    @ApiProperty({
        description: 'Mix typů otázek',
        example: { mcq: 5, tf: 2, msq: 2, cloze: 1 },
        required: false,
    })
    @IsOptional()
    @IsObject()
    mix?: Record<string, number>;

    @ApiProperty({
        description: 'Použitý AI model',
        example: 'gpt-5-mini',
        required: false,
    })
    @IsOptional()
    @IsString()
    model?: string;

    @ApiProperty({
        description: 'Socket ID pro reportování průběhu',
        example: 'socket-123',
        required: false,
    })
    @IsOptional()
    @IsString()
    socketId?: string;
}
