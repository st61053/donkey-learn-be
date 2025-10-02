// src/folders/folders.service.ts
import { Injectable, ForbiddenException, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Folder, FolderDocument } from './schemas/folder.schema';
import { StoredFile } from '../files/schemas/file.schema';
import { CreateFolderDto } from './dto/create-folder.dto';
import { UpdateFolderDto } from './dto/update-folder.dto';

type UserCtx = { userId: string };

@Injectable()
export class FoldersService {
    constructor(
        @InjectModel(Folder.name) private readonly folderModel: Model<Folder>,
        @InjectModel(StoredFile.name) private readonly fileModel: Model<StoredFile>,
    ) { }

    async create(dto: CreateFolderDto, user: UserCtx) {
        const created = await this.folderModel.create({
            name: dto.name,
            color: dto.color,
            icon: dto.icon,
            ownerId: user.userId,
        });
        return this.toResponse(created);
    }

    async list(user: UserCtx) {
        const rows = await this.folderModel.find({ ownerId: user.userId }).sort({ createdAt: -1 }).lean();
        return rows.map(this.toResponseLean);
    }

    async getOne(id: string, user: UserCtx) {
        const f = await this.folderModel.findById(id).lean();
        if (!f) throw new NotFoundException('Folder not found');
        if (f.ownerId !== user.userId) throw new ForbiddenException('Not allowed');
        return this.toResponseLean(f);
    }

    async update(id: string, dto: UpdateFolderDto, user: UserCtx) {
        const f = await this.folderModel.findOneAndUpdate(
            { _id: id, ownerId: user.userId },
            { $set: dto },
            { new: true },
        );
        if (!f) throw new NotFoundException('Folder not found');
        return this.toResponse(f);
    }

    async remove(id: string, user: UserCtx) {
        // kontrola prázdnosti složky (folderId je v StoredFile jako ObjectId)
        let folderObjectId: Types.ObjectId;
        try {
            folderObjectId = new Types.ObjectId(id);
        } catch {
            throw new NotFoundException('Folder not found');
        }

        const itemCount = await this.fileModel.countDocuments({ folderId: folderObjectId, uploaderId: user.userId });
        if (itemCount > 0) {
            return { ok: false as const, reason: 'Folder not empty', itemCount };
        }

        const res = await this.folderModel.deleteOne({ _id: id, ownerId: user.userId });
        if (res.deletedCount === 0) throw new NotFoundException('Folder not found');
        return { ok: true as const };
    }

    private toResponse(doc: FolderDocument) {
        return {
            id: doc.id, // bezpečné – Mongoose virtual
            name: doc.name,
            color: doc.color ?? null,
            icon: doc.icon ?? null,
        };
    }
    private toResponseLean = (r: any) => ({ id: r._id.toString(), name: r.name, color: r.color ?? null, icon: r.icon ?? null });
}
