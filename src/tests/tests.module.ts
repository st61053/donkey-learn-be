// src/tests/tests.module.ts
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { TestsController } from './tests.controller';
import { TestsService } from './tests.service';
import { Test, TestSchema } from './schemas/test.schema';
import { StoredFile, StoredFileSchema } from '../files/schemas/file.schema';
import { Chunk, ChunkSchema } from '../files/schemas/chunk.schema';
import { AiModule } from '../ai/ai.module';
import { SocketGateway } from './ws/socket.gateway';
import { ChunkSelectorService } from 'src/ai/chunk-selector.service';

// ⬇⬇⬇ přidej tyto dva importy
import { MinioModule } from '../minio/minio.module';
import { FilesModule } from '../files/files.module';

@Module({
    imports: [
        AiModule,
        MinioModule,   // ⬅️ přidá MinioService do DI kontextu
        FilesModule,   // ⬅️ přidá FilesService do DI kontextu
        MongooseModule.forFeature([
            { name: Test.name, schema: TestSchema },
            { name: StoredFile.name, schema: StoredFileSchema },
            { name: Chunk.name, schema: ChunkSchema },
        ]),
    ],
    controllers: [TestsController],
    providers: [TestsService, SocketGateway, ChunkSelectorService],
    exports: [TestsService],
})
export class TestsModule { }
