import { IsOptional, IsArray, IsMongoId } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateFileDto {
    @ApiPropertyOptional({ type: [String], example: ['invoice', '2025', 'finance'] })
    @IsArray()
    @IsOptional()
    tags?: string[];

    @ApiProperty({ description: 'Target folder id', example: '66cf19ee2e3a4b5c6d7e8f8f' })
    @IsMongoId()
    folderId!: string;
}