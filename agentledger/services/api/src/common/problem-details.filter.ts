import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import { Request, Response } from 'express';

/**
 * Maps every thrown error to an RFC 7807 problem+json document — the documented
 * problem-details shape the spec mandates for TS services. Never leaks internals:
 * unknown errors become a generic 500 with no message/stack in the body.
 *
 * Exception: SCIM Error objects (RFC 7644 §3.12) are returned as-is with
 * application/scim+json. IdPs (Entra/Okta) require that envelope; rewriting them
 * to problem+json makes Entra report SystemForCrossDomainIdentityManagementServiceIncompatible.
 */
interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance: string;
  errors?: unknown;
}

const SCIM_ERROR_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:Error';

function isScimErrorBody(body: unknown): body is Record<string, unknown> {
  if (!body || typeof body !== 'object') {
    return false;
  }
  const schemas = (body as Record<string, unknown>).schemas;
  return Array.isArray(schemas) && schemas.includes(SCIM_ERROR_SCHEMA);
}

@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      if (isScimErrorBody(body)) {
        res.status(status).type('application/scim+json').send(body);
        return;
      }

      let title = 'Internal Server Error';
      let detail: string | undefined;
      let errors: unknown;

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
      return;
    }

    const problem: ProblemDetails = {
      type: 'about:blank',
      title: 'Internal Server Error',
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      instance: req.originalUrl,
    };
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).type('application/problem+json').send(problem);
  }
}
