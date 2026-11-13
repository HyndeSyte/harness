// A command the link runs (git, ssh), bounded: at its time limit it's killed outright,
// and the call returns then, even when a child of it (ssh, under git) still holds its
// output open. A timeout answers code 124, as timeout(1) does.
export interface Ran { code: number; out: string; err: string }

export async function runBounded(args: string[], env: Record<string, string>, timeoutMs: number): Promise<Ran> {
  const p = Bun.spawn(args, { stdout: "pipe", stderr: "pipe", stdin: "ignore", env });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<Ran>((done) => {
    timer = setTimeout(() => {
      try { p.kill(9); } catch { /* already gone */ }
      done({ code: 124, out: "", err: `timed out after ${Math.round(timeoutMs / 1000)}s` });
    }, timeoutMs);
  });
  const finished = (async (): Promise<Ran> => {
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    return { code: await p.exited, out, err };
  })();
  try { return await Promise.race([finished, late]); }
  finally { clearTimeout(timer); }
}
