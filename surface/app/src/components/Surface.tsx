import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { Loaded, Thread } from "../snapshot";
import { useTheme } from "../theme";
import { stateLine } from "../time";
import { Row } from "./Row";

// The skeleton every screen shares: the state line, Needs you, Next, the screen's own list,
// and the talk bar. Needs you and Next are empty for now and draw nothing.
// Reloads the whole page, so Cloudflare Access can sign the owner in again.
function reloadPage() {
  const loc = (globalThis as { location?: { reload(): void } }).location;
  if (loc && typeof loc.reload === "function") loc.reload();
}

export function Surface({
  loaded,
  now,
  talkUrl,
  needsYou = [],
  next = [],
  onReload = reloadPage,
}: {
  loaded: Loaded | null;
  now: Date;
  talkUrl: string;
  needsYou?: Thread[];
  next?: Thread[];
  onReload?: () => void;
}) {
  const theme = useTheme();
  if (!loaded) return <View style={[styles.fill, { backgroundColor: theme.bg }]} />;
  if (!loaded.ok && loaded.reason === "signin") {
    return (
      <View style={[styles.fill, styles.center, { backgroundColor: theme.bg }]}>
        <Pressable accessibilityRole="button" onPress={onReload} testID="sign-in" style={[styles.signIn, { borderColor: theme.rule }]}>
          <Text style={[styles.notice, { color: theme.text }]}>Sign in again</Text>
        </Pressable>
      </View>
    );
  }
  if (!loaded.ok) {
    return (
      <View style={[styles.fill, styles.center, { backgroundColor: theme.bg }]}>
        <Text style={[styles.notice, { color: theme.muted }]} testID="notice">
          {loaded.reason === "unverified"
            ? "This snapshot could not be verified, so nothing is shown."
            : "No snapshot could be read."}
        </Text>
      </View>
    );
  }
  const { snapshot } = loaded;
  return (
    <View style={[styles.fill, { backgroundColor: theme.bg }]}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.column}>
          <Text style={[styles.stateLine, { color: theme.muted }]} testID="state-line">
            {stateLine(snapshot.made_at, now)}
          </Text>
          {needsYou.length ? (
            <Section title="Needs you" color={theme.accent} testID="needs-you">
              {needsYou.map((t) => (
                <Row key={t.id} thread={t} now={now} theme={theme} />
              ))}
            </Section>
          ) : null}
          {next.length ? (
            <Section title="Next" color={theme.text} testID="next">
              {next.map((t) => (
                <Row key={t.id} thread={t} now={now} theme={theme} />
              ))}
            </Section>
          ) : null}
          <Section title="In motion" color={theme.text} testID="in-motion">
            {snapshot.threads.length ? (
              snapshot.threads.map((t, i) => <Row key={`${t.id}-${i}`} thread={t} now={now} theme={theme} />)
            ) : (
              <Text style={[styles.quiet, { color: theme.muted }]}>Nothing open.</Text>
            )}
            {snapshot.hidden > 0 ? (
              <Text style={[styles.quiet, { color: theme.muted }]} testID="not-shown">
                {snapshot.hidden === 1 ? "1 item not shown" : `${snapshot.hidden} items not shown`}
              </Text>
            ) : null}
          </Section>
        </View>
      </ScrollView>
      <View style={[styles.bar, { backgroundColor: theme.bar, borderTopColor: theme.rule }]}>
        <View style={styles.column}>
          <Pressable
            accessibilityRole="link"
            onPress={() => Linking.openURL(talkUrl)}
            style={[styles.talk, { borderColor: theme.rule, backgroundColor: theme.bg }]}
            testID="talk"
          >
            <Text style={[styles.talkText, { color: theme.text }]}>Talk to Cain</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

function Section({ title, color, testID, children }: { title: string; color: string; testID: string; children: React.ReactNode }) {
  return (
    <View style={styles.section} testID={testID}>
      <Text style={[styles.heading, { color }]} accessibilityRole="header">
        {title}
      </Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: { alignItems: "center", justifyContent: "center", padding: 24 },
  notice: { fontSize: 15 },
  signIn: { borderWidth: 1, borderRadius: 10, paddingVertical: 10, paddingHorizontal: 18 },
  scroll: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 24 },
  // Phone first; on a wide screen the same list sits in a readable column.
  column: { width: "100%", maxWidth: 640, alignSelf: "center" },
  stateLine: { fontSize: 13, marginBottom: 8 },
  section: { marginTop: 16 },
  heading: { fontSize: 13, fontWeight: "600", letterSpacing: 0.4, textTransform: "uppercase", marginBottom: 2 },
  quiet: { fontSize: 14, paddingVertical: 12 },
  bar: { borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: 16, paddingVertical: 10 },
  talk: { borderWidth: 1, borderRadius: 10, paddingVertical: 12, alignItems: "center" },
  talkText: { fontSize: 16, fontWeight: "500" },
});
