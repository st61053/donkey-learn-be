// src/minio/minio.service.ts
import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client as MinioClient } from 'minio';

function pick<T = string>(cfg: ConfigService, keys: string[], def?: T): T | undefined {
    for (const k of keys) {
        const v = cfg.get<T>(k);
        if (v !== undefined && v !== null && String(v).trim() !== '') return v;
    }
    return def;
}

@Injectable()
export class MinioService {
    private readonly bucket: string;
    private readonly region?: string;
    private readonly allowCreate: boolean;
    private readonly logger = new Logger(MinioService.name);

    constructor(
        private readonly minio: MinioClient,
        private readonly config: ConfigService,
    ) {
        // prefer S3_*, fallback MINIO_*
        this.bucket = pick<string>(this.config, ['S3_BUCKET', 'MINIO_BUCKET'], 'uploads')!;
        const region = pick<string>(this.config, ['S3_REGION', 'MINIO_REGION']);
        this.region = region && region.trim() ? region.trim() : undefined;

        const allow = pick<string>(this.config, ['S3_ALLOW_CREATE_BUCKET', 'MINIO_ALLOW_CREATE_BUCKET'], 'false');
        this.allowCreate = String(allow).toLowerCase() === 'true';
    }

    private async ensureBucket() {
        const exists = await this.minio.bucketExists(this.bucket).catch((err) => {
            this.logger.warn(`bucketExists(${this.bucket}) failed: ${String((err as any)?.code || err)}`);
            return false;
        });
        if (exists) return;

        if (!this.allowCreate) {
            throw new InternalServerErrorException(
                `S3/MinIO bucket "${this.bucket}" does not exist and creation is disabled. ` +
                `Create it manually or set S3_ALLOW_CREATE_BUCKET=true (or MINIO_ALLOW_CREATE_BUCKET=true).`
            );
        }

        try {
            await this.minio.makeBucket(this.bucket, this.region);
            this.logger.log(`Bucket ${this.bucket} created`);
        } catch (err: any) {
            if (err?.code === 'AccessDenied') {
                // možná mezitím vznikl
                const existsNow = await this.minio.bucketExists(this.bucket).catch(() => false);
                if (existsNow) return;
                throw new InternalServerErrorException(
                    `S3/MinIO: AccessDenied when creating bucket "${this.bucket}". ` +
                    `Either pre-create the bucket or grant s3:CreateBucket.`
                );
            }
            if (err?.code === 'BucketAlreadyOwnedByYou' || err?.code === 'BucketAlreadyExists') return;
            throw err;
        }
    }

    async uploadObject(objectName: string, data: Buffer, mimeType?: string) {
        await this.ensureBucket();
        await this.minio.putObject(
            this.bucket,
            objectName,
            data,
            data.length,
            { 'Content-Type': mimeType ?? 'application/octet-stream' },
        );
        return { bucket: this.bucket, objectName };
    }

    async getPresignedUrl(objectName: string, expirySeconds = 3600) {
        await this.ensureBucket();
        return this.minio.presignedGetObject(this.bucket, objectName, expirySeconds);
    }

    async removeObject(objectName: string) {
        await this.minio.removeObject(this.bucket, objectName);
    }

    async removeObjects(objectNames: string[]) {
        if (!objectNames?.length) return;
        await this.minio.removeObjects(this.bucket, objectNames);
    }

    bucketName() {
        return this.bucket;
    }

    async getObjectBuffer(objectName: string): Promise<Buffer> {
        const stream = await this.minio.getObject(this.bucket, objectName);
        const parts: Buffer[] = [];
        return new Promise((resolve, reject) => {
            stream.on('data', (d) => parts.push(Buffer.isBuffer(d) ? d : Buffer.from(d)));
            stream.on('end', () => resolve(Buffer.concat(parts)));
            stream.on('error', reject);
        });
    }
}
