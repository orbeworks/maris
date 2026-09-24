import { createHash } from "node:crypto";

import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
  UseInterceptors,
  applyDecorators,
} from "@nestjs/common";
import type { Request, Response } from "express";
import type { Observable } from "rxjs";
import { catchError, map, throwError } from "rxjs";

export type HttpCacheOptions = {
  etag?: boolean;
  maxAge?: number;
  mustRevalidate?: boolean;
  noCache?: boolean;
  noStore?: boolean;
  sharedMaxAge?: number;
  staleWhileRevalidate?: number;
  visibility?: "private" | "public";
};

@Injectable()
class HttpCacheInterceptor implements NestInterceptor {
  constructor(private readonly options: HttpCacheOptions) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const options = this.options;

    response.setHeader("Cache-Control", cacheControl(options));

    let handledBySend = false;

    const originalSend = response.send.bind(response);

    response.send = ((body?: unknown) => {
      handledBySend = true;

      if (shouldSetEtag(options, response, body)) {
        const etag = etagFor(body);

        response.setHeader("ETag", etag);

        if (etagMatches(request.header("If-None-Match"), etag)) {
          response.status(304);
          return originalSend(undefined);
        }
      }

      return originalSend(body as never);
    }) as Response["send"];

    return next.handle().pipe(
      map((body: unknown) => {
        if (handledBySend || body === response || response.headersSent) {
          return body;
        }

        if (shouldSetEtag(options, response, body)) {
          const etag = etagFor(body);

          response.setHeader("ETag", etag);

          if (etagMatches(request.header("If-None-Match"), etag)) {
            response.status(304);
            return undefined;
          }
        }

        return body;
      }),

      catchError((error: unknown) => {
        if (!response.headersSent) {
          response.setHeader("Cache-Control", "no-store");
        }

        return throwError(() => error);
      }),
    );
  }
}

function shouldSetEtag(
  options: HttpCacheOptions,
  response: Response,
  body: unknown,
): boolean {
  return (
    !options.noStore &&
    options.etag !== false &&
    body !== undefined &&
    body !== null &&
    response.statusCode >= 200 &&
    response.statusCode < 300 &&
    response.statusCode !== 204
  );
}

export function HttpCache(options: HttpCacheOptions = {}): MethodDecorator {
  return applyDecorators(
    UseInterceptors(
      new HttpCacheInterceptor({
        etag: true,
        ...options,
      }),
    ),
  );
}

export function NoStore(): MethodDecorator {
  return HttpCache({
    etag: false,
    noStore: true,
  });
}

function cacheControl(options: HttpCacheOptions): string {
  if (options.noStore) {
    return "no-store";
  }

  if (options.noCache) {
    return "no-cache";
  }

  const directives: string[] = [options.visibility ?? "public"];

  if (options.maxAge !== undefined) {
    directives.push(`max-age=${seconds(options.maxAge)}`);
  }

  if (options.sharedMaxAge !== undefined) {
    directives.push(`s-maxage=${seconds(options.sharedMaxAge)}`);
  }

  if (options.staleWhileRevalidate !== undefined) {
    directives.push(
      `stale-while-revalidate=${seconds(options.staleWhileRevalidate)}`,
    );
  }

  if (options.mustRevalidate) {
    directives.push("must-revalidate");
  }

  return directives.join(", ");
}

function seconds(value: number): number {
  return Math.max(0, Math.floor(value));
}

function etagFor(body: unknown): string {
  const bytes = Buffer.isBuffer(body)
    ? body
    : body instanceof Uint8Array
      ? Buffer.from(body)
      : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));

  return `"${createHash("sha256").update(bytes).digest("hex")}"`;
}

function normalizeEtag(value: string) {
  return value.trim().replace(/^W\//, "");
}

function etagMatches(value: string | undefined, etag: string): boolean {
  if (!value) {
    return false;
  }

  if (value.trim() === "*") {
    return true;
  }

  return value
    .split(",")
    .some((candidate) => normalizeEtag(candidate) === etag);
}
