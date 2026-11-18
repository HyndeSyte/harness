import { fireEvent, render, screen, within } from "@testing-library/react";
import { Linking } from "react-native";
import { Surface } from "../src/components/Surface";
import type { Loaded, Thread } from "../src/snapshot";

const now = new Date("2026-11-18T12:00:00Z");
const thread = (id: string, over: Partial<Thread>): Thread => ({
  id, title: `Title ${id}`, area: "other", who: "cain", step: `Step ${id}.`, waits_for: null,
  outcome: "Done.", last_moved: "2026-11-18T09:00:00Z", state: "moving", ...over,
});

// One row per state, already in the order the loader gives (newest first).
const threads = [
  thread("P1", { state: "running", who: "a build job", last_moved: "2026-11-18T11:30:00Z" }),
  thread("P2", { state: "waiting on you", who: "you", waits_for: "your pick", last_moved: "2026-11-18T09:00:00Z" }),
  thread("P3", { state: "at his PC", who: "at his PC", last_moved: "2026-11-15T12:00:00Z" }),
  thread("P4", { state: "moving", who: "a laptop session", last_moved: "2026-10-20T12:00:00Z" }),
];
const loaded: Loaded = { ok: true, snapshot: { made_at: "2026-11-18T10:00:00Z", threads } };

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
});
