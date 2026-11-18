// Everything the app needs from outside, in one place. Set these with EXPO_PUBLIC_ variables
// (an .env.local file for dev, the build's environment for Pages); nothing else is hard-coded.
export const config = {
  // Where the signed snapshot is read from: the Worker's route, /snapshot on the app's own
  // hostname (so connect-src 'self' holds and no CORS is needed). Dev sets /snapshot.json.
  snapshotUrl: process.env.EXPO_PUBLIC_SURFACE_SNAPSHOT_URL || "/snapshot",
  // The exporter's Ed25519 public key, raw 32 bytes in base64. Empty: nothing verifies.
  publicKey: process.env.EXPO_PUBLIC_SURFACE_PUBLIC_KEY || "",
  // The talk bar's Discord DM link. A placeholder until Cain sets the real one.
  talkUrl: process.env.EXPO_PUBLIC_SURFACE_TALK_URL || "https://discord.com/channels/@me",
};
