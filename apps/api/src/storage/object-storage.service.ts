import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";

import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

@Injectable()
export class ObjectStorageService {
  private readonly client: S3Client | null;
  private readonly bucket: string;
  readonly enabled: boolean;

  constructor(config: ConfigService) {
    const backend = config.get<string>("CHART_STORAGE_BACKEND", "local");
    this.bucket = config.get<string>("ENC_S3_BUCKET", "");
    const endpoint = config.get<string>("ENC_S3_ENDPOINT", "");
    const accessKeyId = config.get<string>("ENC_S3_ACCESS_KEY_ID", "");
    const secretAccessKey = config.get<string>("ENC_S3_SECRET_ACCESS_KEY", "");
    this.enabled = backend === "s3";
    if (
      this.enabled &&
      (!endpoint || !this.bucket || !accessKeyId || !secretAccessKey)
    ) {
      throw new Error(
        "CHART_STORAGE_BACKEND=s3 requires ENC_S3_ENDPOINT, ENC_S3_BUCKET, ENC_S3_ACCESS_KEY_ID and ENC_S3_SECRET_ACCESS_KEY",
      );
    }
    this.client =
      endpoint && accessKeyId && secretAccessKey
        ? new S3Client({
            endpoint,
            region: config.get<string>("ENC_S3_REGION", "auto"),
            forcePathStyle: false,
            credentials: { accessKeyId, secretAccessKey },
          })
        : null;
  }

  private requireClient() {
    if (!this.client || !this.bucket)
      throw new Error("S3 object storage is not configured");
    return this.client;
  }

  async head(key: string) {
    return this.requireClient().send(
      new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }

  async tryHead(key: string) {
    try {
      return await this.head(key);
    } catch (error) {
      const details = error as {
        name?: string;
        $metadata?: { httpStatusCode?: number };
      };

      if (
        details.name === "NotFound" ||
        details.name === "NoSuchKey" ||
        details.$metadata?.httpStatusCode === 404
      )
        return null;

      throw error;
    }
  }

  async getText(key: string) {
    const response = await this.requireClient().send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );

    if (!response.Body) {
      throw new Error(`S3 object ${key} has no body`);
    }

    return response.Body.transformToString("utf-8");
  }

  async getRange(
    key: string,
    offset: number,
    length: number,
    signal?: AbortSignal,
  ) {
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(length) ||
      length <= 0 ||
      length > 32 * 1024 * 1024
    ) {
      throw new Error("Invalid S3 byte range");
    }

    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Range: `bytes=${offset}-${offset + length - 1}`,
    });

    const response = signal
      ? await this.requireClient().send(command, { abortSignal: signal })
      : await this.requireClient().send(command);

    if (!response.Body) {
      throw new Error(`S3 object ${key} has no body`);
    }

    const bytes = await response.Body.transformToByteArray();

    const data = Uint8Array.from(bytes).buffer;

    return response.ETag ? { data, etag: response.ETag } : { data };
  }

  async putFile(
    key: string,
    file: string,
    contentType = "application/octet-stream",
  ) {
    const metadata = await stat(file);
    await this.requireClient().send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: createReadStream(file),
        ContentLength: metadata.size,
        ContentType: contentType,
      }),
    );
    return this.head(key);
  }
}
