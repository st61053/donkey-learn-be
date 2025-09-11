// src/app.module.ts
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TerminusModule } from '@nestjs/terminus';
import { HealthModule } from './health/health.module';
import { MinioModule } from './minio/minio.module';
import { UploadModule } from './upload/upload.module';
import { FilesModule } from './files/files.module';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from './auth/auth.module';
import { FoldersModule } from './folders/folders.module';
import { AiModule } from './ai/ai.module';
import { TestsModule } from './tests/tests.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,          // ↓ zpřístupní ConfigService všude (i v main.ts)
      envFilePath: ['.env'],   // volitelné; cesta k env souboru
    }),
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => ({
        uri: cfg.get<string>('MONGO_URI') ?? 'mongodb://localhost:27017/donkey-learn',
      }),
    }),
    MinioModule, // klient na MinIO
    // UploadModule, // upload endpoint
    AuthModule,
    FoldersModule,
    FilesModule,
    TerminusModule,
    AiModule,
    TestsModule,
    HealthModule,
  ],
})
export class AppModule { }
