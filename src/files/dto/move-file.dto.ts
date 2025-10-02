import { ApiProperty } from '@nestjs/swagger';
import { IsMongoId } from 'class-validator';

export class MoveFileDto {
    @ApiProperty({ description: 'Cílová složka', example: '66cf19ee2e3a4b5c6d7e8f8f' })
    @IsMongoId()
    folderId!: string;
}