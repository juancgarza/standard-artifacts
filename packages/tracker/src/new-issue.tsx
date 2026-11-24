import { useMemo, useState } from "react"
import { XIcon } from "@phosphor-icons/react"
import { issuePriorities, issueStatuses, newId, type Assignee, type Issue, type IssuePerson, type IssuePriority, type IssueStatus, type Member, type TrackerState } from "@standard-artifacts/protocol"
import { AssigneeAvatar, PriorityIcon, StatusIcon } from "./icons"
import { PropertyMenu } from "./menu"
import { assigneesOf, nowIso, peopleOf, sameAssignee, selfPerson } from "./model"

/** Linear-style create dialog: a title, an optional description, and property chips. Enter creates. */
export function NewIssue({
  status: initialStatus,
  state,
  self,
  others,
  onCreate,
  onClose,
}: {
  status: IssueStatus
  state: TrackerState
  self: Member | null
  others: ReadonlyArray<Member>
  onCreate: (issue: Issue) => void
  onClose: () => void
}) {
  const [title, setTitle] = useState("")
  const [description, setDescription] = useState("")
  const [status, setStatus] = useState<IssueStatus>(initialStatus)
  const [priority, setPriority] = useState<IssuePriority>("none")
  const me = selfPerson(self)
  const [owner, setOwner] = useState<IssuePerson | null>(me)
  const [delegate, setDelegate] = useState<Assignee | null>(null)
  const people = useMemo(() => peopleOf(state, self, others), [state, self, others])

  const submit = () => {
    const t = title.trim()
    if (!t) return
    onCreate({
      type: "issue",
      id: newId("is_"),
      number: 0,
      title: t,
      ...(description.trim() && { description: description.trim() }),
      status,
      priority,
      owner,
      delegate,
      source: { via: "web" },
      ...(self && { createdByName: self.name }),
      createdAt: nowIso(),
    })
  }

  return (
    <div className="fixed inset-0 z-40 grid place-items-start justify-center bg-black/25 px-4 pt-[12vh]" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        role="dialog"
        aria-label="New issue"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation()
            onClose()
          }
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            submit()
          }
        }}
        className="w-full max-w-[600px] rounded-xl border border-border bg-bg shadow-[0_16px_50px_rgb(0_0_0/0.18)]"
      >
        <div className="flex items-center gap-2 px-4 pt-3 text-[12px] text-muted">
          New issue
          <div className="flex-1" />
          <button type="button" aria-label="Close" onClick={onClose} className="grid size-6 place-items-center rounded hover:bg-hover">
            <XIcon size={14} />
          </button>
        </div>
        <input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
              e.preventDefault()
              submit()
            }
          }}
          placeholder="Issue title"
          aria-label="Issue title"
          className="w-full bg-transparent px-4 pt-2 text-[18px] font-semibold outline-none placeholder:text-faint"
        />
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Add a description… (markdown)"
          aria-label="Description"
          rows={3}
          className="w-full resize-none bg-transparent px-4 pt-2 text-[14px] leading-6 outline-none placeholder:text-faint"
        />
        <div className="flex flex-wrap items-center gap-1.5 px-3 pb-3">
          <PropertyMenu
            label="Status"
            value={status}
            onChange={setStatus}
            options={issueStatuses.map((s) => ({ value: s.id, label: s.label, icon: <StatusIcon status={s.id} /> }))}
            className="h-7 border border-border px-2 text-[12px]"
          >
            <StatusIcon status={status} size={13} /> {issueStatuses.find((s) => s.id === status)?.label}
          </PropertyMenu>
          <PropertyMenu
            label="Priority"
            value={priority}
            onChange={setPriority}
            options={issuePriorities.map((p) => ({ value: p.id, label: p.label, icon: <PriorityIcon priority={p.id} /> }))}
            className="h-7 border border-border px-2 text-[12px]"
          >
            <PriorityIcon priority={priority} size={13} /> {priority === "none" ? "Priority" : issuePriorities.find((p) => p.id === priority)?.label}
          </PropertyMenu>
          <PropertyMenu
            label="Owner"
            value={owner}
            onChange={setOwner}
            equals={sameAssignee}
            options={[{ value: null, label: "No owner" }, ...people.map((p) => ({ value: p, label: p.name, icon: <AssigneeAvatar who={p} size={16} /> }))]}
            className="h-7 border border-border px-2 text-[12px]"
          >
            <AssigneeAvatar who={owner} size={15} /> {owner ? owner.name : "Owner"}
          </PropertyMenu>
          <PropertyMenu
            label="Delegate"
            value={delegate}
            onChange={setDelegate}
            equals={sameAssignee}
            options={[
              { value: null, label: "Not delegated" },
              ...assigneesOf(people).map((a) => ({ value: a, label: a.name, icon: <AssigneeAvatar who={a} size={16} />, section: a.type === "agent" ? "Agents" : "People" })),
            ]}
            className="h-7 border border-border px-2 text-[12px]"
          >
            <AssigneeAvatar who={delegate} size={15} /> {delegate ? delegate.name : "Delegate"}
          </PropertyMenu>
          <div className="flex-1" />
          <span className="text-[12px] text-faint max-sm:hidden">⌘↵</span>
          <button
            type="button"
            onClick={submit}
            disabled={!title.trim()}
            className="h-7 rounded-md bg-accent px-3 text-[13px] font-medium text-accent-text enabled:hover:opacity-90 disabled:opacity-50"
          >
            Create issue
          </button>
        </div>
      </div>
    </div>
  )
}
