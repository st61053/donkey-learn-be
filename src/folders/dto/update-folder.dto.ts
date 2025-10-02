import { PartialType, ApiPropertyOptional } from '@nestjs/swagger';
import { CreateFolderDto } from './create-folder.dto';
import { IsOptional, IsString, MinLength } from 'class-validator';

export class UpdateFolderDto extends PartialType(CreateFolderDto) {
    @ApiPropertyOptional({ example: 'Přejmenovaná složka' })
    @IsOptional()
    @IsString()
    @MinLength(1)
    name?: string;

    @ApiPropertyOptional({ example: '#33CC66', nullable: true, description: 'Barvu lze změnit, nebo vynechat' })
    @IsOptional()
    @IsString()
    color?: string;

    @ApiPropertyOptional({ example: '📦', nullable: true, description: 'Ikonu lze změnit, nebo vynechat' })
    @IsOptional()
    @IsString()
    icon?: string;
}
