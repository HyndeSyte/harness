import { fireEvent, render, screen, within } from "@testing-library/react";
import { Linking } from "react-native";
import { Surface } from "../src/components/Surface";
import type { Loaded, Thread } from "../src/snapshot";

const now = new Date("2026-11-18T12:00:00Z");
const thread = (id: string, over: Partial<Thread>): Thread => ({
  id, title: `Title ${id}`, area: "other", who: "the assistant", step: `Step ${id}.`, waits_for: null,
  outcome: "Done.", last_moved: "2026-11-18T09:00:00Z", state: "moving", ...over,
});

// One row per state, already in the order the loader gives (newest first).
const threads = [
  thread("P1", { state: "running", who: "a build job", last_moved: "2026-11-18T11:30:00Z" }),
  thread("P2", { state: "waiting on you", who: "you", waits_for: "your pick", last_moved: "2026-11-18T09:00:00Z" }),
  thread("P3", { state: "at his PC", who: "at his PC", last_moved: "2026-11-15T12:00:00Z" }),
  thread("P4", { state: "moving", who: "a laptop session", last_moved: "2026-10-20T12:00:00Z" }),
];
const loaded: Loaded = { ok: true, snapshot: { made_at: "2026-11-18T10:00:00Z", threads, hidden: 0 } };

describe("In motion", () => {
  test("one row per state, in order, with its lines", () => {
    render(<Surface loaded={loaded} now={now} talkUrl="https://discord.example/dm" />);
    expect(screen.getByTestId("state-line").textContent).toBe("As of 10:00 AM");
    const rows = within(screen.getByTestId("in-motion")).getAllByTestId(/^row-/);
    expect(rows.map((r) => r.getAttribute("data-testid"))).toEqual(["row-P1", "row-P2", "row-P3", "row-P4"]);
    const text = (id: string) => screen.getByTestId(`row-${id}`).textContent;
    expect(within(screen.getByTestId("row-P1")).getByTestId("state").textContent).toBe("running");
    expect(text("P1")).toContain("A build job · Step P1.");
    expect(text("P1")).toContain("moved 30 minutes ago");
    expect(within(screen.getByTestId("row-P2")).getByTestId("state").textContent).toBe("waiting on you");
    expect(text("P2")).toContain("Waits for your pick");
    expect(within(screen.getByTestId("row-P3")).getByTestId("state").textContent).toBe("at his PC");
    expect(text("P3")).toContain("moved 3 days ago");
    expect(text("P3")).not.toContain("Waits for");
    expect(within(screen.getByTestId("row-P4")).getByTestId("state").textContent).toBe("moving");
    expect(text("P4")).toContain("moved four weeks ago");
  });

  test("Needs you and Next draw nothing while empty", () => {
    render(<Surface loaded={loaded} now={now} talkUrl="https://discord.example/dm" />);
    expect(screen.queryByTestId("needs-you")).toBeNull();
    expect(screen.queryByTestId("next")).toBeNull();
    expect(screen.queryByText("Needs you")).toBeNull();
  });

  test("the talk bar opens the link from config", () => {
    const open = jest.spyOn(Linking, "openURL").mockResolvedValue(undefined);
    render(<Surface loaded={loaded} now={now} talkUrl="https://discord.example/dm" />);
    fireEvent.click(screen.getByText("Talk to Cain"));
    expect(open).toHaveBeenCalledWith("https://discord.example/dm");
  });

  test("an unverifiable snapshot is one line and nothing else", () => {
    const { container } = render(<Surface loaded={{ ok: false, reason: "unverified" }} now={now} talkUrl="x" />);
    expect(container.textContent).toBe("This snapshot could not be verified, so nothing is shown.");
  });

  test("a snapshot in an unknown format is one line and nothing else", () => {
    const { container } = render(<Surface loaded={{ ok: false, reason: "unsupported" }} now={now} talkUrl="x" />);
    expect(container.textContent).toBe("This snapshot is in a format this app doesn't know, so nothing is shown.");
  });

  test("an expired Access session is one line, Sign in again, that reloads the page", () => {
    const reload = jest.fn();
    const { container } = render(<Surface loaded={{ ok: false, reason: "signin" }} now={now} talkUrl="x" onReload={reload} />);
    expect(container.textContent).toBe("Sign in again");
    fireEvent.click(screen.getByText("Sign in again"));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test("offline is one line with a Retry that fetches again, never a reload", () => {
    const retry = jest.fn();
    const reload = jest.fn();
    const { container } = render(
      <Surface loaded={{ ok: false, reason: "offline" }} now={now} talkUrl="x" onRetry={retry} onReload={reload} />,
    );
    expect(container.textContent).toBe("Offline.Retry");
    fireEvent.click(screen.getByText("Retry"));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(reload).not.toHaveBeenCalled();
  });

  test("the Worker's 403 is one line, not allowed, with no reload", () => {
    const reload = jest.fn();
    const { container } = render(<Surface loaded={{ ok: false, reason: "notallowed" }} now={now} talkUrl="x" onReload={reload} />);
    expect(container.textContent).toBe("This account is not allowed to read the snapshot.");
    expect(screen.queryByText("Sign in again")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(reload).not.toHaveBeenCalled();
  });

  test("the assistant and someone are labelled; the snapshot names no one", () => {
    const rows = [thread("P7", { who: "the assistant" }), thread("P8", { who: "someone" })];
    render(<Surface loaded={{ ok: true, snapshot: { made_at: "2026-11-18T10:00:00Z", threads: rows, hidden: 0 } }} now={now} talkUrl="x" />);
    expect(screen.getByTestId("row-P7").textContent).toContain("Cain · Step P7.");
    expect(screen.getByTestId("row-P8").textContent).toContain("Someone · Step P8.");
  });

  test("an unknown who or state is a plain other label", () => {
    const odd = thread("P9", { who: "other", state: "other" });
    render(<Surface loaded={{ ok: true, snapshot: { made_at: "2026-11-18T10:00:00Z", threads: [odd], hidden: 0 } }} now={now} talkUrl="x" />);
    expect(within(screen.getByTestId("row-P9")).getByTestId("state").textContent).toBe("other");
    expect(screen.getByTestId("row-P9").textContent).toContain("Other · Step P9.");
  });

  test("items not shown are one line, only when there are some", () => {
    render(<Surface loaded={{ ok: true, snapshot: { made_at: "2026-11-18T10:00:00Z", threads, hidden: 3 } }} now={now} talkUrl="x" />);
    expect(screen.getByTestId("not-shown").textContent).toBe("3 items not shown");
  });

  test("no items-not-shown line when nothing is hidden", () => {
    render(<Surface loaded={loaded} now={now} talkUrl="x" />);
    expect(screen.queryByTestId("not-shown")).toBeNull();
  });

  test("a snapshot dated in the future is labelled, never a negative age", () => {
    render(<Surface loaded={{ ok: true, snapshot: { made_at: "2026-11-18T13:00:00Z", threads, hidden: 0 } }} now={now} talkUrl="x" />);
    const line = screen.getByTestId("state-line").textContent!;
    expect(line).toBe("As of 1:00 PM, dated ahead of this device's clock");
    expect(line).not.toMatch(/-\d/);
  });
});
