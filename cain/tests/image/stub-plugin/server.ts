// A stand-in for the Discord plugin's server in the CI image test: CI has no bot token, so
// the login check (c1/tools.ts login-check) gets this, which says what the real one says once
// its gateway connects (and only if a token reached it through its environment), then waits
// on its pipes as the real one does. stub-plugin-fail/ is its failing twin.
if (!process.env.DISCORD_BOT_TOKEN) {
  process.stderr.write("discord channel: login failed: no token\n");
  process.exit(1);
}
process.stderr.write(`discord channel: gateway connected as test#0000 (uid ${process.getuid?.()})\n`);
process.stdin.on("data", () => {});
process.stdin.on("end", () => process.exit(0));
setInterval(() => {}, 60_000);
