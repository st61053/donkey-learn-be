import { ApiProperty } from '@nestjs/swagger';

export class ChunkResponseDto {
    @ApiProperty({ example: '66d00112233aa44bb55cc66d' })
    id!: string;

    @ApiProperty({ description: 'ID dokumentu (StoredFile)', example: '66cf1a1f2e3a4b5c6d7e8f90' })
    documentId!: string;

    @ApiProperty({ description: 'Pořadí chunku v dokumentu (0..N-1)', example: 0 })
    index!: number;

    @ApiProperty({
        description: 'Text chunku',
        example: 'The quick brown fox jumps over the lazy dog.',
    })
    text!: string;

    @ApiProperty({ description: 'Byte/char offset v rámci původního textu (včetně)', example: 0 })
    startOffset!: number;

    @ApiProperty({ description: 'Byte/char offset v rámci původního textu (exkluzivně)', example: 43 })
    endOffset!: number;

    @ApiProperty({ description: 'Index první stránky (1-based), pokud známo', nullable: true, example: 1 })
    pageFrom?: number | null;

    @ApiProperty({ description: 'Index poslední stránky (1-based), pokud známo', nullable: true, example: 1 })
    pageTo?: number | null;

    @ApiProperty({ example: '2025-08-29T18:04:12.345Z' })
    createdAt!: string;

    @ApiProperty({ example: '2025-08-29T18:04:12.345Z' })
    updatedAt!: string;
}
