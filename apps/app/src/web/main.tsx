import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router"
import { WorkspaceProvider } from "./workspace"
import { Shell } from "./components/shell"
import { HomePage } from "./pages/home"
import { ArchivedPage } from "./pages/archived"
import { FolderPage } from "./pages/folder"
import { SettingsPage } from "./pages/settings"
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

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <WorkspaceProvider>
      <RouterProvider router={router} />
    </WorkspaceProvider>
  </StrictMode>,
)
