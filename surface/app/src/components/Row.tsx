import { StyleSheet, Text, View } from "react-native";
import type { Thread, Who } from "../snapshot";
import type { Theme } from "../theme";
import { relative } from "../time";

const WHO_LABEL: Record<Who, string> = {
  you: "You",
  cain: "Cain",
  "a build job": "A build job",
  "a laptop session": "A laptop session",
  "at his PC": "At his PC",
};

// "Waits for The registrar's notice" reads as "Waits for the registrar's notice".
function lowerArticle(text: string): string {
  return /^(The|A|An|His|Your)\s/.test(text) ? text[0].toLowerCase() + text.slice(1) : text;
}

// One thread: its title, who has it and the step, what it waits for, when it moved.
// Its state is a small label in the same place on every row, never a colour.
export function Row({ thread, now, theme }: { thread: Thread; now: Date; theme: Theme }) {
  return (
    <View style={[styles.row, { borderBottomColor: theme.rule }]} testID={`row-${thread.id}`}>
      <View style={styles.top}>
        <Text style={[styles.title, { color: theme.text }]}>{thread.title}</Text>
        <Text style={[styles.label, { color: theme.muted }]} testID="state">
          {thread.state}
        </Text>
      </View>
      <Text style={[styles.quiet, { color: theme.muted }]}>
        {WHO_LABEL[thread.who]} · {thread.step}
      </Text>
      {thread.waits_for ? (
        <Text style={[styles.quiet, { color: theme.muted }]}>Waits for {lowerArticle(thread.waits_for)}</Text>
      ) : null}
      <Text style={[styles.quiet, { color: theme.muted }]}>moved {relative(thread.last_moved, now)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, gap: 3 },
  top: { flexDirection: "row", alignItems: "baseline", gap: 12 },
  title: { flex: 1, fontSize: 17, lineHeight: 23, fontWeight: "500" },
  label: { fontSize: 12, lineHeight: 16, width: 92, textAlign: "right" },
  quiet: { fontSize: 14, lineHeight: 20 },
});
