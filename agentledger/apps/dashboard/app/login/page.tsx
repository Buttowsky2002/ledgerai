import { isDevMode, loginUrl } from '../../lib/auth';

export const dynamic = 'force-dynamic';

export default function LoginPage() {
  return (
    <div className="mx-auto max-w-md py-16">
      <h1 className="mb-2 text-xl font-semibold">Sign in to AgentLedger</h1>
      <p className="mb-6 text-sm text-muted">Single sign-on via your identity provider.</p>
      <div className="space-y-3">
        <a
          href={loginUrl('google')}
          className="block rounded border border-edge bg-panel px-4 py-2.5 text-center text-sm hover:bg-white/5"
        >
          Continue with Google
        </a>
        <a
          href={loginUrl('microsoft')}
          className="block rounded border border-edge bg-panel px-4 py-2.5 text-center text-sm hover:bg-white/5"
        >
          Continue with Microsoft
        </a>
      </div>
      {isDevMode() && (
        <p className="mt-6 rounded border border-edge bg-panel p-3 text-xs text-muted">
          Dev mode: requests use <code className="text-accent">x-tenant-id</code> from
          <code className="text-accent"> AGENTLEDGER_DEV_TENANT_ID</code>; SSO is wired but needs
          provider credentials.
        </p>
      )}
    </div>
  );
}
