import { StrictMode, type ReactNode } from "react"
import { createRoot } from "react-dom/client"
import { createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router"
import { WorkspaceProvider, useWorkspace } from "./workspace"
import { signIn } from "./session"
import { SignInPage } from "./pages/sign-in"
import { Shell } from "./components/shell"
import { HomePage } from "./pages/home"
import { ArchivedPage } from "./pages/archived"
import { FolderPage } from "./pages/folder"
import { SettingsPage } from "./pages/settings"
import { AuthorizePage } from "./pages/authorize"
import "./styles.css"

const rootRoute = createRootRoute({ component: Shell })
const homeRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: HomePage })
// The shell renders artifact pages itself, one per tab (see Pages in shell.tsx); this route only gives them an address.
const artifactRoute = createRoute({ getParentRoute: () => rootRoute, path: "/$kind/$id/{-$item}", component: () => null })

const archivedRoute = createRoute({ getParentRoute: () => rootRoute, path: "/archived", component: ArchivedPage })

const folderRoute = createRoute({ getParentRoute: () => rootRoute, path: "/folders/$id", component: FolderPage })

const settingsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/settings/{-$section}", component: SettingsPage })

const router = createRouter({ routeTree: rootRoute.addChildren([homeRoute, archivedRoute, folderRoute, settingsRoute, artifactRoute]) })

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router
  }
}

/** Signed out in live mode: the sign-in screen instead of the app. */
function Gate({ children }: { children: ReactNode }) {
  const { status, signInProblem } = useWorkspace()
  return status === "signed-out" ? <SignInPage problem={signInProblem} /> : children
}

// An invitation link (WorkOS's, pointed at this app) goes through sign-in, which accepts it and lands on that org.
const invitation = new URLSearchParams(window.location.search).get("invitation_token")
if (invitation) {
  signIn({ invitationToken: invitation, returnTo: "/" })
} else if (window.location.pathname === "/authorize") {
  // Connecting an agent (OAuth consent): a page of its own, without the workspace around it.
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <AuthorizePage />
    </StrictMode>,
  )
} else {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <WorkspaceProvider>
        <Gate>
          <RouterProvider router={router} />
        </Gate>
      </WorkspaceProvider>
    </StrictMode>,
  )
}
