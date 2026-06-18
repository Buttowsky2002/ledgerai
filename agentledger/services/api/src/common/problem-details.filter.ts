import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import { Request, Response } from 'express';

/**
 * Maps every thrown error to an RFC 7807 problem+json document — the documented
 * problem-details shape the spec mandates for TS services. Never leaks internals:
 * unknown errors become a generic 500 with no message/stack in the body.
 */
interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance: string;
  errors?: unknown;
}

@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let title = 'Internal Server Error';
    let detail: string | undefined;
    let errors: unknown;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === 'string') {
        title = body;
      } else if (body && typeof body === 'object') {
        const b = body as Record<string, unknown>;
        title = (b.error as string) ?? exception.name;
        // class-validator pushes an array of messages under `message`.
        if (Array.isArray(b.message)) {
          errors = b.message;
          detail = 'Request validation failed';
        } else if (typeof b.message === 'string') {
          detail = b.message;
        }
        if (typeof b.status === 'string') {
          detail = b.status;
        }
      }
    }

    const problem: ProblemDetails = {
      type: 'about:blank',
      title,
      status,
      detail,
      instance: req.originalUrl,
      errors,
    };
    res.status(status).type('application/problem+json').send(problem);
  }
}
