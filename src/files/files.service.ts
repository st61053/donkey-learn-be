import { Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, FilterQuery, Types } from 'mongoose';
import { StoredFile } from './schemas/file.schema';
import { MinioService } from '../minio/minio.service';
import { PdfTextExtractor } from '../parsing/pdf-text-extractor.service';
import { TextChunker } from '../parsing/text-chunker.service';
import { DocumentStatus } from './schemas/file.schema';
import { Chunk } from './schemas/chunk.schema';
import { Folder } from '../folders/schemas/folder.schema';
import { UniversalTextExtractor } from 'src/parsing/universal-text-extractor.service';

type UserCtx = { userId: string; roles?: string[] };

@Injectable()
export class FilesService {
    constructor(
        @InjectModel(StoredFile.name) private readonly fileModel: Model<StoredFile>,
        @InjectModel(Chunk.name) private readonly chunkModel: Model<Chunk>,
        @InjectModel(Folder.name) private readonly folderModel: Model<Folder>,
        private readonly minio: MinioService,
        private readonly extractor: UniversalTextExtractor,
        private readonly chunker: TextChunker,
    ) { }

    private isAdmin(user?: UserCtx) { return !!user?.roles?.includes('ADMIN'); }
    private ensureOwnerOrAdmin(ownerId: string | undefined | null, user: UserCtx) {
        if (ownerId && ownerId.toString() === user.userId) return;
        if (this.isAdmin(user)) return;
        throw new ForbiddenException('Not allowed');
    }

    // NEW: kontrola vlastnictví složky
    private async assertFolderOwned(folderId: string, user: UserCtx) {
        const ok = await this.folderModel.exists({ _id: folderId, ownerId: user.userId });
        if (!ok) throw new BadRequestException('Folder not found or not owned by user');
    }

    // --- CRUD nad StoredFile ---
    async create(meta: {
        originalName: string; key: string; bucket: string; mime: string; size: number;
        uploaderId: string; tags?: string[]; folderId: string;
    }) {
        await this.assertFolderOwned(meta.folderId, { userId: meta.uploaderId });
        return this.fileModel.create({
            ...meta,
            folderId: new Types.ObjectId(meta.folderId),
        });
    }

    async findAllForUser(user: UserCtx, filter: FilterQuery<StoredFile> = {}, limit = 50, skip = 0) {
        const f: any = { ...filter };

        if (f.folderId && typeof f.folderId === 'string') {
            try { f.folderId = new Types.ObjectId(f.folderId); } catch { }
        }

        if (!this.isAdmin(user)) f.uploaderId = user.userId;

        const rows = await this.fileModel
            .find(f)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .lean();

        return rows.map((r: any) => ({
            id: r._id?.toString?.() ?? r._id,
            originalName: r.originalName,
            key: r.key,
            bucket: r.bucket,
            mime: r.mime,
            size: r.size,
            uploaderId: r.uploaderId,
            folderId: r.folderId?.toString?.() ?? r.folderId,
            tags: r.tags ?? [],
            status: r.status,
            pageCount: r.pageCount,
            createdAt: r.createdAt,
            updatedAt: r.updatedAt,
        }));
    }

    async findByIdForUser(id: string, user: UserCtx) {
        const doc = await this.fileModel.findById(id).lean();
        if (!doc) throw new NotFoundException('File not found');
        this.ensureOwnerOrAdmin(doc.uploaderId, user);
        return doc;
    }

    async getDownloadUrlForUser(id: string, user: UserCtx, expiresSec = 3600) {
        const doc = await this.findByIdForUser(id, user);
        return this.minio.getPresignedUrl(doc.key, expiresSec);
    }

    async removeForUser(id: string, user: UserCtx) {
        const doc = await this.fileModel.findById(id);
        if (!doc) throw new NotFoundException('File not found');
        this.ensureOwnerOrAdmin(doc.uploaderId, user);
        await this.minio.removeObject(doc.key);
        await doc.deleteOne();
        await this.chunkModel.deleteMany({ documentId: id });
        return { ok: true };
    }

    // NEW: přesun do jiné složky
    async moveToFolderForUser(id: string, folderId: string, user: UserCtx) {
        await this.assertFolderOwned(folderId, user);
        const doc = await this.fileModel.findById(id);
        if (!doc) throw new NotFoundException('File not found');
        this.ensureOwnerOrAdmin(doc.uploaderId, user);
        doc.folderId = new Types.ObjectId(folderId);
        await doc.save();
        return { ok: true };
    }

    // --- Chunky ---
    async listChunksForUser(documentId: string, user: UserCtx) {
        const doc = await this.fileModel.findById(documentId).lean();
        if (!doc) throw new NotFoundException('File not found');
        this.ensureOwnerOrAdmin(doc.uploaderId, user);

        const rows = await this.chunkModel
            .find({ documentId })
            .sort({ index: 1 })
            .lean();

        return rows.map((r: any) => ({
            id: r._id?.toString?.() ?? r._id,
            documentId: r.documentId,
            index: r.index,
            text: r.text,
            startOffset: r.startOffset,
            endOffset: r.endOffset,
            pageFrom: r.pageFrom ?? null,
            pageTo: r.pageTo ?? null,
            createdAt: r.createdAt?.toISOString?.() ?? r.createdAt,
            updatedAt: r.updatedAt?.toISOString?.() ?? r.updatedAt,
        }));
    }

    async parseAndChunkForUser(documentId: string, user: UserCtx, size = 1000, overlap = 150) {
        const doc = await this.fileModel.findById(documentId);
        if (!doc) throw new NotFoundException('File not found');
        this.ensureOwnerOrAdmin(doc.uploaderId, user);

        try {
            const buf = await this.minio.getObjectBuffer(doc.key);

            const pages = await this.extractor.extractPerPage(buf, {
                mime: doc.mime,
                filename: doc.originalName,
            });

            const prepared = this.chunker.split(doc.id, pages, size, overlap);
            await this.chunkModel.deleteMany({ documentId: doc.id });
            await this.chunkModel.insertMany(prepared);

            doc.status = DocumentStatus.PARSED;
            (doc as any).pageCount = pages.length;
            await doc.save();

            return { chunksInserted: prepared.length, pageCount: pages.length };
        } catch (e) {
            doc.status = DocumentStatus.FAILED;
            await doc.save();
            throw e;
        }
    }
}
