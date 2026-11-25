import { Effect } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { HttpApiClient } from "effect/http-api"
import { Api } from "@standard-artifacts/protocol"
import { ticket } from "./session"

/**
 * Typed client for the shared HttpApi contract. Signed in (live mode), each
 * request carries the session's current ticket as a bearer token. In dev,
 * `devAs` switches the caller (guest/viewer/agent) via a header the Worker
 * honors only when AUTH_MODE=dev.
 */
export const api = (devAs: string) =>
  HttpApiClient.make(Api, {
    baseUrl: window.location.origin,
    transformClient: HttpClient.mapRequestEffect((request) =>
      Effect.map(
        Effect.promise(() => ticket()),
        (t) => {
          let r = t ? HttpClientRequest.bearerToken(request, t) : request
          if (import.meta.env.DEV && devAs !== "owner") r = HttpClientRequest.setHeader(r, "x-dev-as", devAs)
          return r
        },
      ),
    ),
  }).pipe(Effect.provide(FetchHttpClient.layer))

/** Typed API errors carry a message; anything else (network, decode) gets a generic one. */
export const errorMessage = (e: unknown): string =>
  typeof e === "object" && e !== null && "message" in e && typeof e.message === "string" ? e.message : "Request failed"

/** Whether a failure means "nobody's signed in" (as opposed to "not allowed"). */
export const isUnauthorized = (e: unknown): boolean => typeof e === "object" && e !== null && "_tag" in e && e._tag === "Unauthorized"
