import { WarningIcon } from "@phosphor-icons/react"
import { signIn } from "../session"

/** The Talavera tile (assets/brand), served as the favicon. */
function Mark() {
  return <img src="/favicon.svg" width={36} height={36} alt="" />
}

/**
 * Live mode, signed out. Sign-in itself is WorkOS's hosted page (AuthKit),
 * which comes back here; an invitation link lands on the org it's for. When
 * the server's sign-in isn't configured, this says so instead of offering a
 * button that can only fail.
 */
export function SignInPage({ problem }: { problem: string | null }) {
  return (
    <main className="grid min-h-full place-items-center bg-bg px-4 py-10">
      <div className="w-full max-w-[340px]">
        <Mark />
        <h1 className="mt-6 text-[22px] font-semibold tracking-tight">Sign in to Standard Artifacts</h1>
        <p className="mt-1.5 text-muted">Tables, docs, boards and issue trackers that people and agents edit together.</p>

        {problem ? (
          <div role="alert" className="mt-7 flex gap-2.5 rounded-lg border border-border bg-surface p-3 text-[13px]">
            <WarningIcon size={16} className="mt-0.5 shrink-0 text-danger" />
            <div>
              <div className="font-medium">Sign-in isn't available</div>
              <p className="mt-0.5 text-muted">{problem}</p>
            </div>
          </div>
        ) : (
          <div className="mt-7 space-y-2">
            <button
              type="button"
              onClick={() => signIn()}
              className="flex h-9 w-full items-center justify-center rounded-md bg-accent px-3 font-medium text-accent-text hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              Continue
            </button>
            <button
              type="button"
              onClick={() => signIn({ screen: "sign-up" })}
              className="flex h-9 w-full items-center justify-center rounded-md border border-border px-3 font-medium hover:bg-hover"
            >
              Create an account
            </button>
          </div>
        )}

        <p className="mt-6 text-[13px] text-faint">Got a link to a page? Open it directly; it doesn't need an account.</p>
      </div>
    </main>
  )
}
