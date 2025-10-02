import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { ApiProperty } from '@nestjs/swagger';
import { Document, Types } from 'mongoose';

export enum DocumentStatus {
    UPLOADED = 'UPLOADED',
    PARSED = 'PARSED',
    FAILED = 'FAILED',
}

@Schema({ timestamps: true })
export class StoredFile extends Document {
    @Prop({ required: true }) originalName: string;
    @Prop({ required: true }) key: string;
    @Prop({ required: true }) bucket: string;
    @Prop({ required: true }) mime: string;
    @Prop({ required: true }) size: number;
    @Prop({ required: true }) uploaderId?: string;

    // NEW:
    @Prop({ type: Types.ObjectId, ref: 'Folder', required: true, index: true })
    folderId: Types.ObjectId;

    @Prop({ type: [String], default: [] }) tags: string[];
    @Prop({ enum: DocumentStatus, default: DocumentStatus.UPLOADED }) status: DocumentStatus;
    @Prop() pageCount?: number;
}
export const StoredFileSchema = SchemaFactory.createForClass(StoredFile);

// užitečný složený index
StoredFileSchema.index({ uploaderId: 1, folderId: 1, createdAt: -1 });

export class FileResponseDto {
    @ApiProperty({ example: '66cf1a1f2e3a4b5c6d7e8f90' })
    id: string;

    @ApiProperty({ example: 'invoice-2025-08-01.pdf' })
    originalName: string;

    @ApiProperty({ example: '2025-08-29/6a2d9e3c-0a7b-4b8e-af1d-1a2b3c4d5e6f.pdf' })
    key: string;

    @ApiProperty({ example: 'documents' })
    bucket: string;

    @ApiProperty({ example: 'application/pdf' })
    mime: string;

    @ApiProperty({ example: 482391 })
    size: number;

    @ApiProperty({ example: 'user_123' })
    uploaderId: string;

    @ApiProperty({ example: '66cf19ee2e3a4b5c6d7e8f8f' })
    folderId: string;

    @ApiProperty({ type: [String], example: ['invoice', '2025', 'finance'] })
    tags: string[];

    @ApiProperty({ enum: DocumentStatus, example: DocumentStatus.UPLOADED })
    status: DocumentStatus;

    @ApiProperty({ example: 12, nullable: true })
    pageCount?: number | null;

    @ApiProperty({ example: '2025-08-29T18:04:12.345Z' })
    createdAt: string;

    @ApiProperty({ example: '2025-08-29T18:04:12.345Z' })
    updatedAt: string;
}

StoredFileSchema.index({ uploaderId: 1, folderId: 1, createdAt: -1 });
