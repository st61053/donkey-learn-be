import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Folder, FolderSchema } from './schemas/folder.schema';
import { FoldersController } from './folders.controller';
import { StoredFile, StoredFileSchema } from '../files/schemas/file.schema';
import { FoldersService } from './folders.service';

@Module({
    imports: [
        MongooseModule.forFeature([
            { name: Folder.name, schema: FolderSchema },
            { name: StoredFile.name, schema: StoredFileSchema }, // pro kontrolu „Folder not empty“
        ]),
    ],
    providers: [FoldersService],
    controllers: [FoldersController],
    exports: [MongooseModule],
})
export class FoldersModule { }
