import type { Request, Response } from 'express';
import { docsBearerGuard, docsEnabled, resolveDocsMode } from './docs';

const ENV_KEYS = [
  'NODE_ENV',
  'LEDGERAI_EXPOSE_DOCS',
  'AGENTLEDGER_EXPOSE_DOCS',
  'LEDGERAI_DOCS_TOKEN',
  'AGENTLEDGER_DOCS_TOKEN',
];

describe('docs exposure policy', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = saved[k];
      }
    }
  });

  describe('docsEnabled / resolveDocsMode', () => {
    it('non-production exposes docs', () => {
      process.env.NODE_ENV = 'development';
      expect(docsEnabled()).toBe(true);
      expect(resolveDocsMode()).toBe('enabled');
    });

    it('production default does NOT expose docs', () => {
      process.env.NODE_ENV = 'production';
      expect(docsEnabled()).toBe(false);
      expect(resolveDocsMode()).toBe('disabled');
    });

    it('production opt-in with a token is exposed but protected', () => {
      process.env.NODE_ENV = 'production';
      process.env.LEDGERAI_EXPOSE_DOCS = 'true';
      process.env.LEDGERAI_DOCS_TOKEN = 'secret';
      expect(resolveDocsMode()).toBe('enabled_protected');
    });

    it('production opt-in WITHOUT a token fails closed', () => {
      process.env.NODE_ENV = 'production';
      process.env.LEDGERAI_EXPOSE_DOCS = 'true';
      expect(resolveDocsMode()).toBe('disabled_no_token');
    });

    it('honors the deprecated AGENTLEDGER_EXPOSE_DOCS alias', () => {
      process.env.NODE_ENV = 'production';
      process.env.AGENTLEDGER_EXPOSE_DOCS = 'true';
      process.env.LEDGERAI_DOCS_TOKEN = 'secret';
      expect(resolveDocsMode()).toBe('enabled_protected');
    });

    it('a non-"true" opt-in value does not expose in production', () => {
      process.env.NODE_ENV = 'production';
      process.env.LEDGERAI_EXPOSE_DOCS = '1';
      expect(resolveDocsMode()).toBe('disabled');
    });
  });

  describe('docsBearerGuard', () => {
    // A minimal Response stub plus the state it captured.
    const mkRes = () => {
      const state = { statusCode: 0, headers: {} as Record<string, string>, body: '' };
      const res = {
        setHeader(k: string, v: string) {
          state.headers[k] = v;
          return res;
        },
        status(c: number) {
          state.statusCode = c;
          return res;
        },
        send(b: string) {
          state.body = b;
          return res;
        },
      };
      return { res: res as unknown as Response, state };
    };

    it('passes a request with the correct bearer token', () => {
      const guard = docsBearerGuard('secret');
      let nexted = false;
      const { res, state } = mkRes();
      guard({ headers: { authorization: 'Bearer secret' } } as Request, res, () => {
        nexted = true;
      });
      expect(nexted).toBe(true);
      expect(state.statusCode).toBe(0);
    });

    it('rejects a wrong token with 401 + WWW-Authenticate', () => {
      const guard = docsBearerGuard('secret');
      let nexted = false;
      const { res, state } = mkRes();
      guard({ headers: { authorization: 'Bearer nope' } } as Request, res, () => {
        nexted = true;
      });
      expect(nexted).toBe(false);
      expect(state.statusCode).toBe(401);
      expect(state.headers['WWW-Authenticate']).toBeDefined();
    });

    it('rejects a missing Authorization header', () => {
      const guard = docsBearerGuard('secret');
      let nexted = false;
      const { res, state } = mkRes();
      guard({ headers: {} } as Request, res, () => {
        nexted = true;
      });
      expect(nexted).toBe(false);
      expect(state.statusCode).toBe(401);
    });
  });
});
