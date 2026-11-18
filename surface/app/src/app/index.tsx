import { useEffect, useState } from "react";
import { SafeAreaView } from "react-native-safe-area-context";
import { Surface } from "../components/Surface";
import { config } from "../config";
import { loadSnapshot, type Loaded } from "../snapshot";
import { useTheme } from "../theme";

// In motion: every open thread, drawn from the signed snapshot.
export default function InMotion() {
  const theme = useTheme();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    loadSnapshot(config.snapshotUrl, config.publicKey).then(setLoaded);
    const tick = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(tick);
  }, []);
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.bg }}>
      <Surface loaded={loaded} now={now} talkUrl={config.talkUrl} />
    </SafeAreaView>
  );
}
