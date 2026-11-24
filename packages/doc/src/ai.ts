import {
  ArrowsInIcon,
  ArrowsOutIcon,
  CheckIcon,
  FeatherIcon,
  LightbulbIcon,
  ListDashesIcon,
  MagicWandIcon,
  PenNibIcon,
  TranslateIcon,
  TreeStructureIcon,
  type Icon,
} from "@phosphor-icons/react"
import type { Mention } from "@standard-artifacts/protocol"
import { isActive, summaryOf as summary, useMentions, type AgentRequests } from "@standard-artifacts/room/react"

/** What the doc needs from the host to talk to the agent runner (shared with boards). */
export type DocAi = AgentRequests
export { isActive }
export const useDocMentions = useMentions

export type QuickAction = {
  id: string
  label: string
  icon: Icon
  /** The request the runner gets. */
  prompt: string
  /** Asks for a language next ("Translate to…"). */
  pickLanguage?: true
}

/** Offered with a selection: each rewrites the selected blocks in place (mode "edit"). */
export const editActions: ReadonlyArray<QuickAction> = [
  { id: "improve", label: "Improve writing", icon: MagicWandIcon, prompt: "Improve the writing: clearer and tighter, same meaning and tone." },
  { id: "fix", label: "Fix spelling & grammar", icon: CheckIcon, prompt: "Fix spelling and grammar. Change nothing else." },
  { id: "shorter", label: "Make shorter", icon: ArrowsInIcon, prompt: "Make this shorter. Keep the key points." },
  { id: "longer", label: "Make longer", icon: ArrowsOutIcon, prompt: "Make this longer, with more detail and concrete examples." },
  { id: "simplify", label: "Simplify", icon: FeatherIcon, prompt: "Simplify the language so anyone can follow it." },
  { id: "translate", label: "Translate to…", icon: TranslateIcon, prompt: "Translate to", pickLanguage: true },
]

/** Offered on an empty line (or with no selection): each writes new blocks below (mode "reply"). */
export const replyActions: ReadonlyArray<QuickAction> = [
  { id: "continue", label: "Continue writing", icon: PenNibIcon, prompt: "Continue writing from where the doc leaves off, in the same voice." },
  { id: "summarize", label: "Summarize this doc", icon: ListDashesIcon, prompt: "Summarize this doc in a few bullet points." },
  { id: "brainstorm", label: "Brainstorm ideas", icon: LightbulbIcon, prompt: "Brainstorm ideas that build on this doc, as a bulleted list." },
  { id: "outline", label: "Draft an outline", icon: TreeStructureIcon, prompt: "Draft an outline for this doc, with headings and bullets." },
]

export const languages: ReadonlyArray<string> = ["English", "Spanish", "French", "German", "Portuguese", "Japanese", "Chinese"]

/**
 * The runner appends "(cost $…)" to its summary for the terminal log; people
 * reviewing a suggestion don't need it.
 */
export const summaryOf: (m: Mention | undefined) => string = summary
