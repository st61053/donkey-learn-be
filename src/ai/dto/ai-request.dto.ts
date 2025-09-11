import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsNotEmpty, IsObject, IsOptional, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class AiChunkDto {
    @ApiProperty({ example: 'c_123' })
    @IsString()
    id: string;

    @ApiProperty({ example: 'Krátký, očištěný text chunku...' })
    @IsString()
    text: string;

    @ApiProperty({ required: false, example: 'file_abc' })
    @IsOptional()
    @IsString()
    fileId?: string;
}

export class AiRequestDto {
    @ApiProperty({ example: 'gpt-5-mini', description: 'Model k použití' })
    @IsString()
    model: string;

    @ApiProperty({
        description: 'Textové chunky pro generování otázek',
        type: AiChunkDto,
        isArray: true,
    })
    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => AiChunkDto)
    chunks: AiChunkDto[];

    @ApiProperty({
        description: 'Mix otázek (kolik jakých typů)',
        example: { mcq: 5, tf: 2, msq: 1, cloze: 1 },
    })
    @IsObject()
    mix: Record<string, number>;

    @ApiProperty({
        example: 'Vytvoř smysluplné otázky, které pokryjí hlavní témata z úryvků.',
    })
    @IsString()
    @IsNotEmpty()
    instruction: string;

    @ApiProperty({ required: false, example: 'socket-123' })
    @IsOptional()
    @IsString()
    socketId?: string;
}
