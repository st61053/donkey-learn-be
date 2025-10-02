// src/minio/minio.module.ts
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Client as MinioClient } from 'minio';
import { MinioService } from './minio.service';

@Module({
    imports: [ConfigModule],
    providers: [
        {
            provide: MinioClient,
            useFactory: (config: ConfigService) => {
                // Prefer S3_ENDPOINT (může být plné URL), jinak MINIO_ENDPOINT+MINIO_PORT
                const s3Endpoint = config.get<string>('S3_ENDPOINT');
                let endPoint = config.get<string>('MINIO_ENDPOINT', 'localhost');
                let port = parseInt(config.get<string>('MINIO_PORT', '9000'), 10);
                let useSSL = config.get<string>('MINIO_USE_SSL', 'false') === 'true';

                if (s3Endpoint && s3Endpoint.trim()) {
                    try {
                        const u = new URL(s3Endpoint);
                        endPoint = u.hostname;
                        port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
                        useSSL = u.protocol === 'https:';
                    } catch {
                        // když to není validní URL, necháme MINIO_* fallback
                    }
                }

                const accessKey =
                    config.get<string>('S3_ACCESS_KEY') ||
                    config.get<string>('MINIO_ACCESS_KEY');
                const secretKey =
                    config.get<string>('S3_SECRET_KEY') ||
                    config.get<string>('MINIO_SECRET_KEY');

                if (!accessKey || !secretKey) {
                    throw new Error('Missing S3/MINIO access credentials');
                }

                return new MinioClient({
                    endPoint,
                    port,
                    useSSL,
                    accessKey,
                    secretKey,
                    // region nedávej sem – posíláme ho jen do makeBucket, je volitelný
                });
            },
            inject: [ConfigService],
        },
        MinioService,
    ],
    exports: [MinioService],
})
export class MinioModule { }
