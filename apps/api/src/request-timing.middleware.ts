import type { NextFunction, Request, Response } from "express";
import { Logger, type NestMiddleware } from "@nestjs/common";

/** Logs the final HTTP status and server-side duration for Railway observability. */
export class RequestTimingMiddleware implements NestMiddleware {
  private readonly logger = new Logger("HTTP");

  use(request: Request, response: Response, next: NextFunction) {
    const startedAt = process.hrtime.bigint();

    response.once("finish", () => {
      const durationMs =
        Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      const path = request.originalUrl.split("?", 1)[0];
      this.logger.log(
        `${request.method} ${path} ${response.statusCode} ${Math.round(durationMs)}ms`,
      );
    });

    next();
  }
}
