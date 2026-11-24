import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { after, before, describe, test } from "node:test"
import type { Browser, Locator, Page } from "playwright-core"
import { API, BASE, call, cleanup, content, create, createFolder, drag, eventually, launch, mcpSession, open, trackFolder, viewAsOnly, visit } from "./harness.ts"

/** Folders: a place in the UI and a namespace (Marketing/Launch) for the API, CLI and agents. */

type Snapshot = {
  artifacts: Array<{ id: string; title: string; updatedAt: string; folderId?: string }>
  folders: Array<{ id: string; name: string; parentId: string | null }>
}
const snapshot = async () => (await call<Snapshot>("GET", "/workspace")).body
const artifactIn = async (id: string) => (await snapshot()).artifacts.find((a) => a.id === id)?.folderId
const folderAt = async (id: string) => (await snapshot()).folders.find((f) => f.id === id)
const unique = (name: string) => `e2e ${name} ${Date.now()}${Math.floor(Math.random() * 1000)}`

let browser: Browser
before(async () => {
  browser = await launch()
})
after(async () => {
  await browser?.close()
  await cleanup()
})

describe("folder rules", () => {
  test("folders nest, and show up in the workspace snapshot", async () => {
    const parent = await createFolder(unique("parent"))
    const child = await createFolder("Child", parent.id)
    assert.match(parent.id, /^f_/)
    assert.equal(parent.parentId, null)
    assert.equal(child.parentId, parent.id)
    const { folders } = await snapshot()
    assert.ok(folders.some((f) => f.id === parent.id))
    assert.ok(folders.some((f) => f.id === child.id))
  })

  test("sibling names are unique ignoring case, so a path means one folder", async () => {
    const parent = await createFolder(unique("names"))
    await createFolder("Assets", parent.id)
    const dup = await call("POST", "/folders", { name: "assets", parentId: parent.id })
    assert.equal(dup.status, 400)
    assert.match(dup.body.message, /already here/)
    // The same name elsewhere is fine.
    const other = await createFolder(unique("names other"))
    await createFolder("Assets", other.id)
    // So is renaming to your own name in another case.
    const fixed = await createFolder("Fix", parent.id)
    assert.equal((await call("PATCH", `/folders/${fixed.id}`, { name: "FIX" })).status, 200)
    // Moving into a taken name is refused too.
    const twin = await createFolder("Assets", (await createFolder(unique("names twin"))).id)
    assert.equal((await call("PATCH", `/folders/${twin.id}`, { parentId: parent.id })).status, 400)
  })

  test("names can't hold a slash or be blank", async () => {
    assert.equal((await call("POST", "/folders", { name: "a/b" })).status, 400)
    assert.equal((await call("POST", "/folders", { name: "   " })).status, 400)
  })

  test("no cycles, and six levels at most, counting what moves along", async () => {
    const a = await createFolder(unique("depth"))
    const b = await createFolder("b", a.id)
    const c = await createFolder("c", b.id)
    const self = await call("PATCH", `/folders/${a.id}`, { parentId: a.id })
    assert.equal(self.status, 400)
    const cycle = await call("PATCH", `/folders/${a.id}`, { parentId: c.id })
    assert.equal(cycle.status, 400)
    assert.match(cycle.body.message, /inside itself/)

    const d = await createFolder("d", c.id)
    const e = await createFolder("e", d.id)
    const f = await createFolder("f", e.id)
    const tooDeep = await call("POST", "/folders", { name: "g", parentId: f.id })
    assert.equal(tooDeep.status, 400)
    assert.match(tooDeep.body.message, /6 levels/)

    // A two-level folder fits under level 4 but not under level 5.
    const top = await createFolder(unique("depth mover"))
    await createFolder("inner", top.id)
    assert.equal((await call("PATCH", `/folders/${top.id}`, { parentId: e.id })).status, 400)
    assert.equal((await call("PATCH", `/folders/${top.id}`, { parentId: d.id })).status, 200)
  })

  test("moving an artifact doesn't count as editing it", async () => {
    const folder = await createFolder(unique("move"))
    const a = await create("doc", "move me")
    const before = (await snapshot()).artifacts.find((x) => x.id === a.id)!.updatedAt
    const moved = await call("POST", `/artifacts/${a.id}/move`, { folderId: folder.id })
    assert.equal(moved.status, 200)
    assert.equal(moved.body.folderId, folder.id)
    assert.equal(moved.body.updatedAt, before)
    const back = await call("POST", `/artifacts/${a.id}/move`, { folderId: null })
    assert.equal(back.body.folderId, undefined)
    assert.equal((await call("POST", `/artifacts/${a.id}/move`, { folderId: "f_nope" })).status, 404)
  })

  test("artifacts can be created in a folder; a missing folder is refused", async () => {
    const folder = await createFolder(unique("create in"))
    const made = await call("POST", "/artifacts", { kind: "doc", title: "e2e in folder", folderId: folder.id })
    assert.equal(made.body.folderId, folder.id)
    await call("DELETE", `/artifacts/${made.body.id}`)
    assert.equal((await call("POST", "/artifacts", { kind: "doc", title: "e2e nowhere", folderId: "f_nope" })).status, 404)
  })

  test("deleting a folder deletes nothing else: contents move up, a clashing subfolder gets a number", async () => {
    const top = await createFolder(unique("delete"))
    const doomed = await createFolder("Doomed", top.id)
    const clash = await createFolder("Assets", doomed.id)
    await createFolder("Assets", top.id)
    const doc = await create("doc", "survivor")
    const board = await create("board", "archived survivor")
    await call("POST", `/artifacts/${doc.id}/move`, { folderId: doomed.id })
    await call("POST", `/artifacts/${board.id}/move`, { folderId: doomed.id })
    await call("POST", `/artifacts/${board.id}/archive`)

    assert.equal((await call("DELETE", `/folders/${doomed.id}`)).status, 200)

    assert.equal(await folderAt(doomed.id), undefined)
    assert.equal(await artifactIn(doc.id), top.id)
    assert.equal((await content(doc.id)).artifact.id, doc.id, "content is intact")
    const moved = await folderAt(clash.id)
    assert.equal(moved?.parentId, top.id)
    assert.equal(moved?.name, "Assets 2")
    // An archived artifact has somewhere to come back to.
    assert.equal((await call("POST", `/artifacts/${board.id}/restore`)).body.folderId, top.id)
  })

  test("deleting a top-level folder moves its contents to the root", async () => {
    const top = await createFolder(unique("delete root"))
    const child = await createFolder(unique("delete root child"), top.id)
    const doc = await create("doc", "root survivor")
    await call("POST", `/artifacts/${doc.id}/move`, { folderId: top.id })
    await call("DELETE", `/folders/${top.id}`)
    assert.equal(await artifactIn(doc.id), undefined)
    assert.equal((await folderAt(child.id))?.parentId, null)
  })

  test("viewers and guests can read folders but not change them", async () => {
    const folder = await createFolder(unique("perms"))
    const doc = await create("doc", "perms doc")
    for (const as of ["viewer", "guest"] as const) {
      assert.ok((await call<Snapshot>("GET", "/workspace", undefined, as)).body.folders.some((f) => f.id === folder.id), as)
      assert.equal((await call("POST", "/folders", { name: unique("nope") }, as)).status, 403, as)
      assert.equal((await call("PATCH", `/folders/${folder.id}`, { name: "nope" }, as)).status, 403, as)
      assert.equal((await call("DELETE", `/folders/${folder.id}`, undefined, as)).status, 403, as)
      assert.equal((await call("POST", `/artifacts/${doc.id}/move`, { folderId: folder.id }, as)).status, 403, as)
    }
  })

  test("a share-link guest learns nothing about how the org files things", async () => {
    const folder = await createFolder(unique("secret plans"))
    const doc = await create("doc", "shared doc")
    await call("POST", `/artifacts/${doc.id}/move`, { folderId: folder.id })
    const link = await call("POST", `/artifacts/${doc.id}/link`)
    const get = async (path: string) => {
      const res = await fetch(`${API}${path}`, { headers: { authorization: `Bearer ${link.body.token}` } })
      return { status: res.status, text: await res.text() }
    }
    const workspace = await get("/workspace")
    assert.equal(workspace.status, 200)
    const snap = JSON.parse(workspace.text) as Snapshot
    assert.deepEqual(snap.folders, [])
    assert.deepEqual(snap.artifacts.map((a) => a.id), [doc.id])
    assert.equal(snap.artifacts[0]!.folderId, undefined)
    const read = await get(`/artifacts/${doc.id}/content`)
    assert.equal(read.status, 200)
    assert.ok(!read.text.includes(folder.id), "the folder id stays out of the content")
  })
})

describe("folders as namespaces", () => {
  const bin = fileURLToPath(new URL("../../apps/cli/dist/stdartifacts.mjs", import.meta.url))
  const cli = (...args: Array<string>) => {
    const r = spawnSync(process.execPath, [bin, ...args], { env: { ...process.env, STDARTIFACTS_URL: BASE }, encoding: "utf8" })
    return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() }
  }

  test("CLI: paths create, list, resolve and move", async () => {
    const root = unique("cli").replaceAll(" ", "-")
    const made = cli("folder", "new", `${root}/Launch`)
    assert.equal(made.code, 0, made.err)
    const leaf = (await snapshot()).folders.find((f) => f.name === "Launch" && made.out.startsWith(f.id))!
    const top = (await folderAt(leaf.parentId!))!
    trackFolder(leaf.id)
    trackFolder(top.id)
    assert.equal(top.name, root)
    // Asking again finds the same folder, ignoring case.
    assert.match(cli("folder", "new", `${root.toUpperCase()}/launch`).out, new RegExp(`^${leaf.id}`))

    const doc = await create("doc", unique("cli doc"))
    assert.equal(cli("mv", doc.id, `${root}/Launch`).code, 0)
    assert.equal(await artifactIn(doc.id), leaf.id)
    assert.match(cli("ls", "--folder", `${root}/Launch`).out, new RegExp(doc.id))
    assert.doesNotMatch(cli("ls", "--folder", "/").out, new RegExp(doc.id))
    assert.match(cli("ls").out, new RegExp(`${root}/Launch/${doc.title}`))
    // A ref can go through the path.
    assert.equal(cli("read", `${root}/Launch/${doc.title}`).code, 0)
    assert.match(cli("folder", "ls").out, new RegExp(`${root}/Launch  \\(1\\)`))

    const made2 = cli("new", "board", unique("cli board"), "--folder", `${root}/Launch/Deep`)
    assert.equal(made2.code, 0, made2.err)
    const board = made2.out.split(/\s+/)[0]!
    const deep = (await artifactIn(board))!
    trackFolder(deep)
    assert.equal((await folderAt(deep))?.name, "Deep")
    assert.equal(cli("rm", board).code, 0)

    assert.equal(cli("mv", doc.id, "/").code, 0)
    assert.equal(await artifactIn(doc.id), undefined)
    const wrong = cli("folder", "rm", `${root}/Nope`)
    assert.equal(wrong.code, 1)
    assert.match(wrong.err, /No folder matches/)
  })

  test("MCP: agents organize work by path", async () => {
    const mcp = await mcpSession()
    const root = unique("mcp").replaceAll(" ", "-")
    const { tools } = (await mcp.request("tools/list")).result
    for (const name of ["list_folders", "create_folder", "move_artifact", "update_folder", "delete_folder"]) {
      assert.ok(tools.some((t: { name: string }) => t.name === name), name)
    }
    assert.equal(tools.find((t: { name: string }) => t.name === "list_folders").annotations.readOnlyHint, true)

    const made = await mcp.tool("create_folder", { path: `${root}/Research` })
    assert.equal(made.error, false, made.text)
    const leafId = /f_\w+/.exec(made.text)![0]
    trackFolder(leafId)
    trackFolder((await folderAt(leafId))!.parentId!)

    const created = await mcp.tool("create_artifact", { kind: "doc", title: "e2e mcp filed", folder: `${root}/Research` })
    assert.match(created.text, new RegExp(`in ${root}/Research`))
    const id = /d_\w+/.exec(created.text)![0]
    assert.equal(await artifactIn(id), leafId)

    assert.match((await mcp.tool("list_artifacts", { folder: `${root}/Research` })).text, new RegExp(id))
    assert.match((await mcp.tool("list_artifacts", {})).text, new RegExp(`${id}.*\\(in ${root}/Research\\)`))
    assert.match((await mcp.tool("list_folders", {})).text, new RegExp(`${root}/Research  \\(1 artifact\\)`))

    const renamed = await mcp.tool("update_folder", { folder: `${root}/Research`, name: "Findings" })
    assert.match(renamed.text, new RegExp(`${root}/Findings`))
    assert.match((await mcp.tool("read_artifact", { artifact: `${root}/Findings/e2e mcp filed` })).text, new RegExp(id))

    const refused = await mcp.tool("update_folder", { folder: `${root}/Findings`, name: "a/b" })
    assert.equal(refused.error, true)

    const moved = await mcp.tool("move_artifact", { artifact: id, folder: "/" })
    assert.match(moved.text, /workspace root/)
    assert.equal(await artifactIn(id), undefined)

    const removed = await mcp.tool("delete_folder", { folder: `${root}/Findings` })
    assert.equal(removed.error, false, removed.text)
    assert.equal(await folderAt(leafId), undefined)
    await call("DELETE", `/artifacts/${id}`)
  })
})

describe("folders in the app", () => {
  const nav = (page: Page) => page.getByRole("navigation", { name: "Workspace" })
  const tree = (page: Page) => nav(page).getByRole("region", { name: "Folders" })
  const center = async (l: Locator) => {
    const b = (await l.boundingBox())!
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
  }

  test("make a folder and a subfolder in the sidebar; a taken name stays open with the reason", async () => {
    const { page, errors } = await open(browser, "owner", { width: 1400, height: 900 })
    await visit(page, BASE, nav(page).getByRole("button", { name: "New folder" }))
    const name = unique("sidebar")

    await tree(page).hover()
    await nav(page).getByRole("button", { name: "New folder" }).click()
    const input = page.getByRole("textbox", { name: "New folder name" })
    await input.fill(name)
    await input.press("Enter")
    const link = tree(page).getByRole("link", { name })
    await link.waitFor()
    const id = (await eventually(async () => (await snapshot()).folders.find((f) => f.name === name)))!.id
    trackFolder(id)

    // A sibling with the same name is refused in place.
    await tree(page).hover()
    await nav(page).getByRole("button", { name: "New folder" }).click()
    await input.fill(name.toUpperCase())
    await input.press("Enter")
    await page.getByRole("alert").filter({ hasText: "already here" }).waitFor()
    await input.press("Escape")
    await input.waitFor({ state: "detached" })

    // A subfolder, from the row's + menu.
    await link.hover()
    await page.getByRole("button", { name: `New in ${name}` }).click()
    await page.getByRole("menuitem", { name: "Subfolder" }).click()
    await input.fill("Inner")
    await input.press("Enter")
    await tree(page).getByRole("link", { name: "Inner" }).waitFor()
    const inner = (await eventually(async () => (await snapshot()).folders.find((f) => f.parentId === id)))!
    trackFolder(inner.id)
    assert.equal(inner.name, "Inner")

    // Open folders are remembered.
    await page.reload()
    await tree(page).getByRole("link", { name: "Inner" }).waitFor()
    await page.getByRole("button", { name: `Collapse ${name}` }).click()
    await tree(page).getByRole("link", { name: "Inner" }).waitFor({ state: "detached" })
    assert.deepEqual(errors, [])
  })

  test("the folder page: breadcrumb, rename in place, contents, create inside", async () => {
    const top = await createFolder(unique("page"))
    const sub = await createFolder("Sub", top.id)
    const doc = await create("doc", unique("page doc"))
    await call("POST", `/artifacts/${doc.id}/move`, { folderId: sub.id })
    const { page, errors } = await open(browser, "owner", { width: 1400, height: 900 })

    await visit(page, `${BASE}/folders/${top.id}`, page.getByRole("button", { name: "New folder" }).first())
    const main = page.locator("main")
    await main.getByRole("link", { name: "Sub" }).click()
    await page.waitForURL(`**/folders/${sub.id}`)
    await main.getByRole("link", { name: new RegExp(doc.title) }).waitFor()
    // The page's folder is open in the tree, down to where it is.
    await tree(page).getByRole("link", { name: doc.title }).waitFor()

    const crumbs = main.getByRole("navigation", { name: "Breadcrumb" })
    await crumbs.getByRole("link", { name: top.name }).waitFor()

    // Rename in the breadcrumb: Escape reverts, Enter saves.
    const title = main.getByRole("textbox", { name: "Folder name" })
    await title.fill("Abandoned")
    await title.press("Escape")
    assert.equal(await title.inputValue(), "Sub")
    assert.equal((await folderAt(sub.id))?.name, "Sub")
    await title.fill("Renamed")
    await title.press("Enter")
    await eventually(async () => (await folderAt(sub.id))?.name === "Renamed")
    await tree(page).getByRole("link", { name: "Renamed" }).waitFor()

    // Created here means filed here.
    await main.getByRole("button", { name: "New", exact: true }).click()
    await page.getByRole("menuitem", { name: "Table" }).click()
    await page.waitForURL(/\/tables\/t_/)
    const tableId = new URL(page.url()).pathname.split("/")[2]!
    assert.equal(await artifactIn(tableId), sub.id)
    // Its header leads back through the folder.
    await page.locator("header").getByRole("link", { name: "Renamed" }).click()
    await page.waitForURL(`**/folders/${sub.id}`)
    await call("DELETE", `/artifacts/${tableId}`)
    assert.deepEqual(errors, [])
  })

  test("an empty folder offers to create; an unknown one says not found", async () => {
    const empty = await createFolder(unique("empty"))
    const { page, errors } = await open(browser, "owner", { width: 1400, height: 900 })
    await visit(page, `${BASE}/folders/${empty.id}`, page.getByText("This folder is empty"))
    await page.locator("main").getByRole("button", { name: "New doc" }).click()
    await page.waitForURL(/\/docs\/d_/)
    const docId = new URL(page.url()).pathname.split("/")[2]!
    assert.equal(await artifactIn(docId), empty.id)
    await call("DELETE", `/artifacts/${docId}`)
    await visit(page, `${BASE}/folders/f_missing`, page.getByText("Not found."))
    assert.deepEqual(errors, [])
  })

  test("move dialog: filter, keyboard, a new folder from inside it, and a blocked destination", async () => {
    const stamp = unique("dialog")
    const target = await createFolder(`${stamp} target`)
    const doc = await create("doc", unique("dialog doc"))
    const { page, errors } = await open(browser, "owner", { width: 1400, height: 900 })

    await visit(page, `${BASE}/docs/${doc.id}`, page.getByRole("button", { name: "More" }))
    await page.getByRole("button", { name: "More" }).click()
    await page.getByRole("menuitem", { name: "Move to folder…" }).click()
    const dialog = page.getByRole("dialog", { name: `Move ${doc.title}` })
    await dialog.getByRole("heading", { name: `Move “${doc.title}” to folder` }).waitFor()
    const moveHere = dialog.getByRole("button", { name: "Move here" })
    assert.equal(await moveHere.isDisabled(), true, "it's already here")

    // Typing picks the first match; Enter moves it.
    await dialog.getByRole("combobox").fill(`${stamp} target`)
    await dialog.getByRole("option", { name: `${stamp} target` }).waitFor()
    await dialog.getByRole("combobox").press("Enter")
    await dialog.waitFor({ state: "detached" })
    await eventually(async () => (await artifactIn(doc.id)) === target.id)
    await page.locator("header").getByRole("link", { name: target.name }).waitFor()

    // Make a folder from inside the dialog, then move there. It nests under the selected one.
    await page.getByRole("button", { name: "More" }).click()
    await page.getByRole("menuitem", { name: "Move to folder…" }).click()
    await dialog.getByRole("button", { name: "New folder" }).click()
    const name = dialog.getByRole("textbox", { name: "New folder name" })
    await name.fill("Made in dialog")
    await name.press("Enter")
    await dialog.getByRole("option", { name: "Made in dialog", selected: true }).waitFor()
    await moveHere.click()
    await dialog.waitFor({ state: "detached" })
    const made = (await eventually(async () => (await snapshot()).folders.find((f) => f.parentId === target.id && f.name === "Made in dialog")))!
    trackFolder(made.id)
    assert.equal(await eventually(() => artifactIn(doc.id).then((id) => id === made.id && id)), made.id)

    // A folder can't go inside itself: the option is there, but disabled.
    await visit(page, `${BASE}/folders/${target.id}`, page.getByRole("button", { name: `${target.name} actions` }).last())
    await page.locator("header").getByRole("button", { name: `${target.name} actions` }).click()
    await page.getByRole("menuitem", { name: "Move to folder…" }).click()
    const folderDialog = page.getByRole("dialog", { name: `Move ${target.name}` })
    const blocked = folderDialog.getByRole("option", { name: "Made in dialog" })
    assert.equal(await blocked.getAttribute("aria-disabled"), "true")
    await blocked.click({ force: true })
    assert.equal(await blocked.getAttribute("aria-selected"), "false", "clicking it doesn't pick it")
    assert.equal(await folderDialog.getByRole("button", { name: "Move here" }).isDisabled(), true)
    await folderDialog.getByRole("button", { name: "Cancel" }).click()
    assert.deepEqual(errors, [])
  })

  test("drag an artifact and a folder onto a folder in the sidebar, then back to the root", async () => {
    const stamp = unique("drag")
    const dest = await createFolder(`${stamp} dest`)
    const mover = await createFolder(`${stamp} mover`)
    const doc = await create("doc", `${stamp} doc`)
    // Tall, so every row is on screen however many folders earlier tests have left in the sidebar.
    const { page, errors } = await open(browser, "owner", { width: 1400, height: 3000 })
    await visit(page, `${BASE}/folders/${dest.id}`, tree(page).getByRole("link", { name: dest.name }))

    // Onto a folder row, from the page's "Docs" section in the sidebar.
    const row = nav(page).getByRole("region", { name: "Docs" }).getByRole("link", { name: doc.title })
    await row.waitFor()
    await drag(page, await center(row), await center(tree(page).getByRole("link", { name: dest.name })))
    await eventually(async () => (await artifactIn(doc.id)) === dest.id)
    await page.locator("main").getByRole("link", { name: new RegExp(doc.title) }).waitFor()

    // A folder too.
    await drag(page, await center(tree(page).getByRole("link", { name: mover.name })), await center(tree(page).getByRole("link", { name: dest.name })))
    await eventually(async () => (await folderAt(mover.id))?.parentId === dest.id)

    // Dropping a folder on itself does nothing.
    const self = tree(page).getByRole("link", { name: dest.name })
    await drag(page, await center(self), { ...(await center(self)), x: (await center(self)).x + 4 })
    assert.equal((await folderAt(dest.id))?.parentId, null)

    // The section header is the root.
    const header = tree(page).getByRole("button", { name: /^Folders/ })
    await drag(page, await center(tree(page).getByRole("link", { name: mover.name })), await center(header))
    await eventually(async () => (await folderAt(mover.id))?.parentId === null)

    // Landing on a row inside a folder files it in that folder, not at the root.
    const other = await create("doc", `${stamp} other`)
    await page.reload()
    const otherRow = nav(page).getByRole("region", { name: "Docs" }).getByRole("link", { name: other.title })
    await otherRow.waitFor()
    await drag(page, await center(otherRow), await center(tree(page).getByRole("link", { name: doc.title })))
    await eventually(async () => (await artifactIn(other.id)) === dest.id)
    assert.deepEqual(errors, [])
  })

  test("deleting from the menu says where things go, and leaves the page if you're on it", async () => {
    const top = await createFolder(unique("menu delete"))
    const doomed = await createFolder("Doomed", top.id)
    const doc = await create("doc", unique("menu delete doc"))
    await call("POST", `/artifacts/${doc.id}/move`, { folderId: doomed.id })
    const { page, errors } = await open(browser, "owner", { width: 1400, height: 900 })

    await visit(page, `${BASE}/folders/${doomed.id}`, page.locator("header").getByRole("button", { name: "Doomed actions" }))
    await page.locator("header").getByRole("button", { name: "Doomed actions" }).click()
    await page.getByRole("menuitem", { name: "Delete folder…" }).click()
    const panel = page.getByRole("dialog", { name: "Doomed actions" })
    await panel.getByText(`The item in “Doomed” will move to ${top.name}.`).waitFor()
    await panel.getByRole("button", { name: "Cancel" }).click()
    assert.ok(await folderAt(doomed.id), "Cancel keeps it")
    await panel.getByRole("menuitem", { name: "Delete folder…" }).click()
    await panel.getByRole("button", { name: "Delete folder" }).click()
    await page.waitForURL(`**/folders/${top.id}`)
    await page.locator("main").getByRole("link", { name: new RegExp(doc.title) }).waitFor()
    assert.equal(await folderAt(doomed.id), undefined)
    assert.equal(await artifactIn(doc.id), top.id)
    assert.deepEqual(errors, [])
  })

  test("search finds folders, and artifacts by the folder they're in", async () => {
    const stamp = `Zephyr${Date.now()}`
    const folder = await createFolder(stamp)
    const doc = await create("doc", "palette filed")
    await call("POST", `/artifacts/${doc.id}/move`, { folderId: folder.id })
    const { page, errors } = await open(browser, "owner", { width: 1400, height: 900 })
    await visit(page, BASE, nav(page).getByRole("button", { name: "Search" }))

    await nav(page).getByRole("button", { name: "Search" }).click()
    const search = page.getByRole("dialog", { name: "Search" })
    await search.getByRole("combobox").fill(stamp)
    await search.getByRole("option", { name: new RegExp(`${stamp}.*Folder`) }).waitFor()
    // Same query, through the path.
    await search.getByRole("option", { name: new RegExp(`${doc.title}.*${stamp}`) }).waitFor()
    await search.getByRole("option", { name: new RegExp(`${stamp}.*Folder`) }).click()
    await page.waitForURL(`**/folders/${folder.id}`)
    assert.deepEqual(errors, [])
  })

  test("Home has a Folders tab; list rows say where things live", async () => {
    const folder = await createFolder(unique("home tab"))
    const doc = await create("doc", unique("home doc"))
    await call("POST", `/artifacts/${doc.id}/move`, { folderId: folder.id })
    const { page, errors } = await open(browser, "owner", { width: 1400, height: 900 })
    await visit(page, BASE, page.getByRole("tab", { name: /^Folders/ }))

    await page.getByRole("button", { name: "List view" }).click()
    const row = page.locator("main").getByRole("listitem").filter({ hasText: doc.title })
    await row.getByText(folder.name).waitFor()

    await page.getByRole("tab", { name: /^Folders/ }).click()
    await page.getByRole("tabpanel").getByRole("link", { name: new RegExp(folder.name) }).click()
    await page.waitForURL(`**/folders/${folder.id}`)
    assert.deepEqual(errors, [])
  })

  test("Home's overview lists folders before artifacts, in grid and list; filter tabs don't", async () => {
    const folder = await createFolder(unique("first"))
    const doc = await create("doc", unique("newer than the folder"))
    const { page, errors } = await open(browser, "owner", { width: 1400, height: 900 })
    await visit(page, BASE, page.getByRole("tabpanel").getByRole("link", { name: new RegExp(folder.name) }))
    const hrefs = () => page.getByRole("tabpanel").getByRole("link").evaluateAll((links) => links.map((l) => l.getAttribute("href") ?? ""))
    const foldersLead = async () => {
      const all = await hrefs()
      const isFolder = all.map((h) => h.includes("/folders/"))
      assert.ok(all.some((h) => h.includes(folder.id)), "the folder is listed")
      assert.ok(all.some((h) => h.includes(doc.id)), "the newer doc is listed")
      assert.equal(isFolder.lastIndexOf(true), isFolder.filter(Boolean).length - 1, `folders come first: ${all.join(" ")}`)
    }

    await page.getByRole("button", { name: "Grid view" }).click()
    await foldersLead()
    await page.getByRole("button", { name: "List view" }).click()
    await foldersLead()

    await page.getByRole("tab", { name: /^Docs/ }).click()
    await page.getByRole("tabpanel").getByRole("link", { name: new RegExp(doc.title) }).waitFor()
    assert.equal((await hrefs()).filter((h) => h.includes("/folders/")).length, 0)
    assert.deepEqual(errors, [])
  })

  test("a viewer can browse but gets no way to change anything", viewAsOnly, async () => {
    const folder = await createFolder(unique("viewer"))
    const doc = await create("doc", unique("viewer doc"))
    await call("POST", `/artifacts/${doc.id}/move`, { folderId: folder.id })
    const { page, errors } = await open(browser, "viewer", { width: 1400, height: 900 })
    await visit(page, `${BASE}/folders/${folder.id}`, page.locator("main").getByRole("link", { name: new RegExp(doc.title) }))

    assert.equal(await page.getByRole("button", { name: "New folder" }).count(), 0)
    assert.equal(await page.getByRole("button", { name: `${folder.name} actions` }).count(), 0)
    assert.equal(await page.getByRole("button", { name: "Move to folder" }).count(), 0)
    assert.equal(await page.getByRole("textbox", { name: "Folder name" }).count(), 0)
    assert.equal(await page.locator("main").getByRole("listitem").first().getAttribute("draggable"), null)
    assert.deepEqual(errors, [])
  })
})
