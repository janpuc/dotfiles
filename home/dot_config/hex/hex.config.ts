// Hex transformations for hermes, managed by chezmoi (dotfiles). Pick "Tidy speech" in Hex's Output pane.
// Reference: https://anoma.ly/hex/docs/transforms
import { defineHexConfig } from "@hex/commands"

// Hesitations, English and Polish, as whole words. A comma or ellipsis after one goes with it.
const FILLER = /(?<![\p{L}\p{N}'’-])(?:u+h+|u+h*m+|erm+|hmm+|y{3,}|e{3,})(?![\p{L}\p{N}'’-])(?:\s*(?:,|…|\.\.\.))?/giu
// Short words a stumble doubles ("the the"). "that that", "had had" and "is is" can be right, so they stay.
const REPEAT = /(?<![\p{L}\p{N}'’-])(the|a|an|and|to|of|in|on|for|at|it|i|we|you|my|this|with|but|or|when|where|some)(?:\s+\1)+(?![\p{L}\p{N}'’-])/giu
const MARK = "\u0001"

function tidy(text: string): string {
  let t = text.replace(FILLER, (m) => (m[0] !== m[0].toLowerCase() ? MARK : ""))
  // A capitalised filler that started a sentence hands its capital to the next word.
  t = t.replace(/\u0001+([^\p{L}]*)(\p{Ll})/gu, (_, pre, c) => pre + c.toUpperCase()).replaceAll(MARK, "")
  for (let prev; prev !== t; ) { prev = t; t = t.replace(REPEAT, "$1") }
  return t
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+([,.!?;:])/g, "$1")
    .replace(/,([.!?])/g, "$1")
    .replace(/(?<!\.)([.!?])[ \t]*\.(?!\.)/g, "$1")
    .replace(/,{2,}/g, ",")
    .replace(/^[ \t,.…]+|[ \t]+$/gm, "")
}

export default defineHexConfig({
  transformations: {
    "tidy-speech": {
      name: "Tidy speech",
      description: "Drop uh, um, yyy and eee, and doubled short words like 'the the'",
      transform: (text: string) => tidy(text),
    },
  },
})
