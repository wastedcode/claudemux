import { InvalidSessionName } from "../errors.js";

/**
 * Characters the substrate cannot safely encode into a backend target
 * name. The current tmux backend uses `<namespace>--<name>` and tmux's
 * target grammar parses `session:window.pane`; passing `.` or `:` in
 * either field silently renames (with `_`) and produces an un-addressable
 * handle. The substrate rejects these at the boundary instead.
 *
 * `/` and `\` and whitespace are rejected as a general defensive measure
 * — they aren't reserved by tmux per se, but they break shell-quoting
 * assumptions in any tooling that pastes a session name into a script.
 * `*` and `?` are tmux's glob metacharacters and would silently match
 * other sessions. Empty string is rejected because `<namespace>--`
 * is a valid prefix but a meaningless target.
 */
const RESERVED_CHARS = [".", ":", "*", "?", "/", "\\", "\n", "\r", "\t", " "];

/** Validate a `name` or `namespace` field. Throws {@link InvalidSessionName}. */
export function validateNamePart(field: "name" | "namespace", value: string): void {
  if (value.length === 0) {
    throw new InvalidSessionName(field, value, "must not be empty");
  }
  if (value.startsWith("-")) {
    // Leading `-` is parsed as a tmux flag by some commands.
    throw new InvalidSessionName(field, value, "must not start with '-'");
  }
  for (const ch of RESERVED_CHARS) {
    if (value.includes(ch)) {
      const human = ch === "\n" ? "\\n" : ch === "\r" ? "\\r" : ch === "\t" ? "\\t" : ch;
      throw new InvalidSessionName(
        field,
        value,
        `must not contain ${JSON.stringify(human)} (reserved by the substrate's target encoding)`,
      );
    }
  }
}
