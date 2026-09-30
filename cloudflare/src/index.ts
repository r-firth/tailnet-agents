// Familiar Cloudflare runner (UNTESTED — written without access to a
// Cloudflare account). The coordinator calls:
//   POST /machines/:name/start  {id, server, token, fork_of?}
//   POST /machines/:name/backup
//   POST /machines/:name/stop
// Each machine is one Sandbox. Its home directory is restored from R2 on
// start and saved back to R2 on backup, so installs, files and browser logins
// persist while the container itself sleeps. Forks restore their parent's
// latest backup. When the native Sandbox backup/restore API is verified, swap
// saveHome/restoreHome for it (faster, no base64 round trip).
import { getSandbox, type Sandbox } from '@cloudflare/sandbox';
export { Sandbox } from '@cloudflare/sandbox';

interface Env {
  Sandbox: DurableObjectNamespace<Sandbox>;
  MACHINES: R2Bucket;
  RUNNER_TOKEN: string;
}

const HOME = '/home/agent';

async function restoreHome(sandbox: ReturnType<typeof getSandbox>, env: Env, name: string) {
  const obj = await env.MACHINES.get(`${name}/home.tar.gz`);
  if (!obj) return false;
  const bytes = new Uint8Array(await obj.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  await sandbox.writeFile('/tmp/home.tar.gz', btoa(binary), { encoding: 'base64' });
  await sandbox.exec(`mkdir -p ${HOME} && tar xzf /tmp/home.tar.gz -C ${HOME} && rm -f ${HOME}/.config/familiar-chrome/Singleton* /tmp/home.tar.gz`);
  return true;
}

async function saveHome(sandbox: ReturnType<typeof getSandbox>, env: Env, name: string) {
  await sandbox.exec(`tar --exclude=./.cache --exclude='*/Cache' --exclude='*/Code Cache' -czf /tmp/home.tar.gz -C ${HOME} . || true`);
  const file = await sandbox.readFile('/tmp/home.tar.gz', { encoding: 'base64' });
  const content = (file as { content: string }).content ?? (file as unknown as string);
  const bytes = Uint8Array.from(atob(content), (c) => c.charCodeAt(0));
  await env.MACHINES.put(`${name}/home.tar.gz`, bytes);
  await env.MACHINES.put(`${name}/backups/${new Date().toISOString()}.tar.gz`, bytes);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.headers.get('authorization') !== `Bearer ${env.RUNNER_TOKEN}`) return new Response('unauthorized', { status: 401 });
    const url = new URL(request.url);
    const m = url.pathname.match(/^\/machines\/([a-z0-9-]+)\/(start|backup|stop)$/);
    if (!m || request.method !== 'POST') return new Response('not found', { status: 404 });
    const [, name, action] = m;
    const sandbox = getSandbox(env.Sandbox, name);
    try {
      if (action === 'start') {
        const body = (await request.json()) as { id: string; server: string; token: string; fork_of?: string };
        const restored = (await restoreHome(sandbox, env, name)) || (body.fork_of ? await restoreHome(sandbox, env, body.fork_of) : false);
        await sandbox.startProcess(
          `bash -lc 'Xvfb :99 -screen 0 1280x800x24 >/dev/null 2>&1 & sleep 1; DISPLAY=:99 fluxbox >/dev/null 2>&1 & ` +
            `x11vnc -display :99 -forever -shared -nopw -rfbport 5900 >/dev/null 2>&1 & websockify --web /usr/share/novnc 6080 localhost:5900 >/dev/null 2>&1 & ` +
            `cd /opt/familiar/machine && DISPLAY=:99 node dist/main.js --server ${body.server} --token ${body.token} --id ${body.id} --name ${name} --backend cloudflare --home ${HOME}'`,
        );
        return Response.json({ ok: true, restored });
      }
      if (action === 'backup') {
        await saveHome(sandbox, env, name);
        return Response.json({ ok: true });
      }
      await saveHome(sandbox, env, name).catch(() => {});
      await sandbox.destroy();
      return Response.json({ ok: true });
    } catch (e) {
      return Response.json({ ok: false, error: String(e) }, { status: 500 });
    }
  },
};
