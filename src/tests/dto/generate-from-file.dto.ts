import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Min, Max, IsOptional, IsString, IsObject } from 'class-validator';
import { Transform, Type } from 'class-transformer';

export class GenerateFromFileDto {
    @ApiProperty({ example: 'Test', description: 'Název testu' })
    @IsString()
    title!: string;

    @ApiProperty({ example: 90, description: 'Délka testu v minutách (1–600)' })
    @Type(() => Number)              // ← převede "90" (string) na number
    @IsInt()
    @Min(1)
    @Max(600)
    duration!: number;

    @ApiProperty({
        description: 'Mix typů otázek',
        example: { mcq: 26, tf: 1, msq: 2, cloze: 0 },
    })
    @Transform(({ value }) => {
        // Povolit: objekt nebo JSON string z multipart/form-data
        if (value == null) return value;
        if (typeof value === 'string') {
            try { return JSON.parse(value); } catch { /* spadne do validace níž */ }
        }
        return value;
    })
    @IsObject()
    mix!: Record<string, number>;

    @ApiProperty({ example: 'gpt-5-mini', required: false })
    @IsString()
    @IsOptional()
    model?: string;
}
