import { ArgumentsHost, HttpException } from '@nestjs/common';
import { ProblemDetailsFilter } from './problem-details.filter';

function mockHost(url = '/scim/v2/Users/x') {
  const res = {
    statusCode: 0,
    contentType: '',
    body: null as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    type(t: string) {
      this.contentType = t;
      return this;
    },
    send(body: unknown) {
      this.body = body;
      return this;
    },
  };
  const host = {
    switchToHttp: () => ({
      getResponse: () => res,
      getRequest: () => ({ originalUrl: url }),
    }),
  } as ArgumentsHost;
  return { host, res };
}

describe('ProblemDetailsFilter', () => {
  const filter = new ProblemDetailsFilter();

  it('passes SCIM Error envelopes through as application/scim+json', () => {
    const { host, res } = mockHost();
    const scimBody = {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
      status: '400',
      scimType: 'invalidValue',
      detail: 'userName or an email is required',
    };
    filter.catch(new HttpException(scimBody, 400), host);
    expect(res.statusCode).toBe(400);
    expect(res.contentType).toBe('application/scim+json');
    expect(res.body).toEqual(scimBody);
  });

  it('maps ordinary HttpExceptions to problem+json', () => {
    const { host, res } = mockHost('/v1/agents');
    filter.catch(new HttpException({ error: 'Bad Request', message: 'nope' }, 400), host);
    expect(res.statusCode).toBe(400);
    expect(res.contentType).toBe('application/problem+json');
    expect(res.body).toMatchObject({
      type: 'about:blank',
      status: 400,
      detail: 'nope',
      instance: '/v1/agents',
    });
  });
});
